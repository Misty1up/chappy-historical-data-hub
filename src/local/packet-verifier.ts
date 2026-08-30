import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import {
  CANONICAL_SCHEMA_VERSION,
  DATASET_ID_PREFIX,
  DATASET_PACKET_MANIFEST_SCHEMA_VERSION,
  assertSha256,
  hashEntriesRoot,
} from '../packet/contract.js';
import type { DatasetPacketManifest, PacketFileBinding } from '../packet/types.js';

export type LocalImportStatus = 'DISCOVERED' | 'VALIDATED' | 'IMPORTED' | 'ALREADY_REGISTERED' | 'FAIL' | 'HOLD';

export type LocalPacketFailureCode =
  | 'PACKET_NOT_FOUND'
  | 'AMBIGUOUS_PACKET_DISCOVERY'
  | 'UNSAFE_ARCHIVE_ENTRY'
  | 'ZIP_FORMAT_UNSUPPORTED'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_PARSE_FAIL'
  | 'MANIFEST_CONTRACT_UNSUPPORTED'
  | 'SHA256SUMS_MISSING'
  | 'SHA256SUMS_PARSE_FAIL'
  | 'SHA256_MISMATCH'
  | 'PACKET_FILE_MISSING'
  | 'PACKET_INVENTORY_MISMATCH'
  | 'INTEGRITY_NOT_ACCEPTED'
  | 'CANONICAL_PROMOTION_NOT_ALLOWED'
  | 'DATASET_BINDING_MISMATCH'
  | 'WINDOWS_PATH_UNSAFE'
  | 'INTERNAL_ERROR';

export class LocalPacketError extends Error {
  constructor(
    public readonly code: LocalPacketFailureCode,
    public readonly status: 'FAIL' | 'HOLD',
    message: string,
  ) {
    super(message);
    this.name = 'LocalPacketError';
  }
}

interface PacketEntry {
  relativePath: string;
  size: number;
}

interface PacketSource {
  readonly sourceType: 'DIRECTORY' | 'ZIP';
  readonly packetRootDisplay: string;
  listEntries(): Promise<PacketEntry[]>;
  readBytes(relativePath: string, maxBytes?: number): Promise<Buffer>;
  sha256(relativePath: string): Promise<string>;
}

export interface LocalPacketScanResult {
  local_import_status: 'VALIDATED';
  mutation_performed: false;
  input_type: 'DIRECTORY' | 'ZIP';
  input_path: string;
  resolved_packet_root: string;
  dataset_id: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  tick_count_total: number;
  source_hash_root: string;
  canonical_logical_hash_root: string;
  parquet_file_hash_root: string;
  mt5_derivative_hash_root: string;
  precision_status: 'VERIFIED';
  integrity_status: 'PASS';
  canonical_promotion_allowed: true;
  packet_file_count: number;
  packet_total_bytes: number;
  sha256sums_checked_files: number;
  sha256_mismatch_count: 0;
  manifest_sha256: string;
  sha256sums_sha256: string;
  registry_file_status: 'NOT_PRESENT' | 'PRESENT_UNVERIFIED_P5_1';
  intended_destination_path: string;
}

interface ZipEntryRecord {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  flags: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

const METADATA_MAX_BYTES = 16 * 1024 * 1024;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_EOCD_MAX_SEARCH = 65_557;

function error(code: LocalPacketFailureCode, status: 'FAIL' | 'HOLD', message: string): never {
  throw new LocalPacketError(code, status, message);
}

function isEnoent(value: unknown): boolean {
  return (value as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function safePacketRelativePath(value: string, label: string): string {
  if (!value || value.includes('\0') || isAbsolute(value) || value.startsWith('/') || value.startsWith('\\')) {
    error('SHA256SUMS_PARSE_FAIL', 'FAIL', `${label} is not a safe Packet-relative path`);
  }
  if (value.includes('\\')) {
    error('SHA256SUMS_PARSE_FAIL', 'FAIL', `${label} must use forward slashes exactly as emitted by the accepted Packet builder`);
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    error('SHA256SUMS_PARSE_FAIL', 'FAIL', `${label} contains an empty/traversal path segment`);
  }
  if (/^[A-Za-z]:/.test(value)) error('SHA256SUMS_PARSE_FAIL', 'FAIL', `${label} must not contain a drive-qualified path`);
  return value;
}

function safeArchivePath(rawName: string): string {
  if (!rawName || rawName.includes('\0')) error('UNSAFE_ARCHIVE_ENTRY', 'HOLD', 'ZIP entry has an empty or NUL-containing path');
  const normalized = rawName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    error('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP entry is absolute or drive-qualified: ${rawName}`);
  }
  const isDirectory = normalized.endsWith('/');
  const body = isDirectory ? normalized.slice(0, -1) : normalized;
  const segments = body.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    error('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP entry contains an unsafe path segment: ${rawName}`);
  }
  return body;
}

function assertContained(root: string, candidate: string, code: LocalPacketFailureCode = 'WINDOWS_PATH_UNSAFE'): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const back = relative(resolvedRoot, resolvedCandidate);
  if (!back || back === '.' || back === '..' || back.startsWith('../') || back.startsWith('..\\') || isAbsolute(back)) {
    error(code, 'HOLD', `Path escapes or does not identify a file beneath the selected root: ${candidate}`);
  }
}

async function sha256DirectoryFile(packetRoot: string, relativePath: string): Promise<string> {
  const absolute = resolve(packetRoot, relativePath);
  assertContained(packetRoot, absolute);
  const fileStat = await lstat(absolute).catch(cause => {
    if (isEnoent(cause)) error('PACKET_FILE_MISSING', 'FAIL', `Packet file is missing: ${relativePath}`);
    throw cause;
  });
  if (fileStat.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet file is a symbolic link/reparse-like entry: ${relativePath}`);
  if (!fileStat.isFile()) error('PACKET_FILE_MISSING', 'FAIL', `Packet path is not a regular file: ${relativePath}`);
  const hash = createHash('sha256');
  const stream = createReadStream(absolute);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function walkDirectoryFiles(packetRoot: string, current = packetRoot): Promise<PacketEntry[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: PacketEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    assertContained(packetRoot, absolute);
    if (entry.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet tree contains a symbolic link/reparse-like entry: ${absolute}`);
    if (entry.isDirectory()) {
      files.push(...await walkDirectoryFiles(packetRoot, absolute));
      continue;
    }
    if (!entry.isFile()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet tree contains a non-regular filesystem entry: ${absolute}`);
    const rel = relative(packetRoot, absolute).replaceAll('\\', '/');
    files.push({ relativePath: rel, size: (await stat(absolute)).size });
  }
  return files;
}

async function discoverDirectoryPacketRoots(root: string, current = root, roots: string[] = []): Promise<string[]> {
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Selected directory tree contains a symbolic link/reparse-like entry: ${current}`);
  if (!currentStat.isDirectory()) return roots;
  if (basename(current) === 'DATA_PACKET') roots.push(resolve(current));
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    if (entry.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Selected directory tree contains a symbolic link/reparse-like entry: ${absolute}`);
    if (entry.isDirectory()) await discoverDirectoryPacketRoots(root, absolute, roots);
  }
  return roots;
}

class DirectoryPacketSource implements PacketSource {
  readonly sourceType = 'DIRECTORY' as const;
  constructor(public readonly packetRootDisplay: string) {}

  async listEntries(): Promise<PacketEntry[]> {
    return await walkDirectoryFiles(this.packetRootDisplay);
  }

  async readBytes(relativePath: string, maxBytes = METADATA_MAX_BYTES): Promise<Buffer> {
    safePacketRelativePath(relativePath, 'Packet read path');
    const absolute = resolve(this.packetRootDisplay, relativePath);
    assertContained(this.packetRootDisplay, absolute);
    const fileStat = await lstat(absolute).catch(cause => {
      if (isEnoent(cause)) error('PACKET_FILE_MISSING', 'FAIL', `Packet file is missing: ${relativePath}`);
      throw cause;
    });
    if (fileStat.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet file is a symbolic link/reparse-like entry: ${relativePath}`);
    if (!fileStat.isFile()) error('PACKET_FILE_MISSING', 'FAIL', `Packet path is not a regular file: ${relativePath}`);
    if (fileStat.size > maxBytes) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Metadata file exceeds bounded read size: ${relativePath}`);
    return await readFile(absolute);
  }

  async sha256(relativePath: string): Promise<string> {
    safePacketRelativePath(relativePath, 'Packet hash path');
    return await sha256DirectoryFile(this.packetRootDisplay, relativePath);
  }
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error('Unexpected EOF while reading ZIP');
    offset += bytesRead;
  }
  return buffer;
}

class ZipArchive {
  private constructor(
    private readonly zipPath: string,
    private readonly records: Map<string, ZipEntryRecord>,
  ) {}

  static async load(zipPath: string): Promise<ZipArchive> {
    const handle = await open(zipPath, 'r');
    try {
      const zipStat = await handle.stat();
      if (!zipStat.isFile()) error('PACKET_NOT_FOUND', 'FAIL', `ZIP input is not a regular file: ${zipPath}`);
      if (zipStat.size < ZIP_EOCD_MIN_SIZE) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP is too small to contain an end-of-central-directory record');
      const tailSize = Math.min(zipStat.size, ZIP_EOCD_MAX_SEARCH);
      const tail = await readExact(handle, zipStat.size - tailSize, tailSize);
      let eocd = -1;
      for (let index = tail.length - ZIP_EOCD_MIN_SIZE; index >= 0; index -= 1) {
        if (tail.readUInt32LE(index) === 0x06054b50) {
          eocd = index;
          break;
        }
      }
      if (eocd < 0) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP end-of-central-directory record was not found');
      const diskNumber = tail.readUInt16LE(eocd + 4);
      const centralDisk = tail.readUInt16LE(eocd + 6);
      const entriesOnDisk = tail.readUInt16LE(eocd + 8);
      const totalEntries = tail.readUInt16LE(eocd + 10);
      const centralSize = tail.readUInt32LE(eocd + 12);
      const centralOffset = tail.readUInt32LE(eocd + 16);
      if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
        error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'Multi-disk ZIP archives are not supported');
      }
      if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP64 archive metadata is not supported by the Phase 5 MVP reader');
      }
      if (centralOffset + centralSize > zipStat.size) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP central directory is outside the file bounds');
      const central = await readExact(handle, centralOffset, centralSize);
      const records = new Map<string, ZipEntryRecord>();
      let cursor = 0;
      for (let index = 0; index < totalEntries; index += 1) {
        if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
          error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP central directory entry is malformed');
        }
        const flags = central.readUInt16LE(cursor + 8);
        const compressionMethod = central.readUInt16LE(cursor + 10);
        const compressedSize = central.readUInt32LE(cursor + 20);
        const uncompressedSize = central.readUInt32LE(cursor + 24);
        const nameLength = central.readUInt16LE(cursor + 28);
        const extraLength = central.readUInt16LE(cursor + 30);
        const commentLength = central.readUInt16LE(cursor + 32);
        const externalAttributes = central.readUInt32LE(cursor + 38);
        const localHeaderOffset = central.readUInt32LE(cursor + 42);
        const recordLength = 46 + nameLength + extraLength + commentLength;
        if (cursor + recordLength > central.length) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP central directory entry exceeds its bounds');
        const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        const name = safeArchivePath(rawName);
        const unixMode = (externalAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) error('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP contains a symbolic-link entry: ${rawName}`);
        if ((flags & 0x1) !== 0) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `Encrypted ZIP entry is not supported: ${rawName}`);
        if (compressionMethod !== 0 && compressionMethod !== 8) {
          error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `Unsupported ZIP compression method ${compressionMethod}: ${rawName}`);
        }
        const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\') || (unixMode & 0o170000) === 0o040000;
        if (!isDirectory) {
          if (records.has(name)) error('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP contains duplicate normalized file paths: ${name}`);
          records.set(name, { name, compressedSize, uncompressedSize, compressionMethod, flags, localHeaderOffset, externalAttributes });
        }
        cursor += recordLength;
      }
      return new ZipArchive(resolve(zipPath), records);
    } finally {
      await handle.close();
    }
  }

  fileNames(): string[] {
    return [...this.records.keys()].sort((a, b) => a.localeCompare(b));
  }

  private record(name: string): ZipEntryRecord {
    const record = this.records.get(name);
    if (!record) error('PACKET_FILE_MISSING', 'FAIL', `ZIP Packet file is missing: ${name}`);
    return record;
  }

  private async dataRange(record: ZipEntryRecord): Promise<{ start: number; end: number }> {
    const handle = await open(this.zipPath, 'r');
    try {
      const header = await readExact(handle, record.localHeaderOffset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `ZIP local header is malformed: ${record.name}`);
      const localFlags = header.readUInt16LE(6);
      const localMethod = header.readUInt16LE(8);
      const nameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      if (localFlags !== record.flags || localMethod !== record.compressionMethod) {
        error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `ZIP local/central metadata mismatch: ${record.name}`);
      }
      const localName = (await readExact(handle, record.localHeaderOffset + 30, nameLength)).toString('utf8');
      if (safeArchivePath(localName) !== record.name) error('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP local/central path mismatch: ${record.name}`);
      const start = record.localHeaderOffset + 30 + nameLength + extraLength;
      const end = start + record.compressedSize - 1;
      return { start, end };
    } finally {
      await handle.close();
    }
  }

  async readBytes(name: string, maxBytes = METADATA_MAX_BYTES): Promise<Buffer> {
    const record = this.record(name);
    if (record.uncompressedSize > maxBytes) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Metadata ZIP entry exceeds bounded read size: ${name}`);
    if (record.compressedSize === 0) return Buffer.alloc(0);
    const { start, end } = await this.dataRange(record);
    const source = createReadStream(this.zipPath, { start, end });
    const stream = record.compressionMethod === 0 ? source : source.pipe(createInflateRaw());
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maxBytes) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Metadata ZIP entry exceeded bounded read size while inflating: ${name}`);
      chunks.push(buffer);
    }
    if (bytes !== record.uncompressedSize) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `ZIP uncompressed size mismatch: ${name}`);
    return Buffer.concat(chunks, bytes);
  }

  async sha256(name: string): Promise<string> {
    const record = this.record(name);
    const hash = createHash('sha256');
    if (record.compressedSize === 0) return hash.digest('hex');
    const { start, end } = await this.dataRange(record);
    const source = createReadStream(this.zipPath, { start, end });
    const stream = record.compressionMethod === 0 ? source : source.pipe(createInflateRaw());
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      hash.update(buffer);
    }
    if (bytes !== record.uncompressedSize) error('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `ZIP uncompressed size mismatch while hashing: ${name}`);
    return hash.digest('hex');
  }

  entrySize(name: string): number {
    return this.record(name).uncompressedSize;
  }
}

class ZipPacketSource implements PacketSource {
  readonly sourceType = 'ZIP' as const;
  constructor(
    private readonly archive: ZipArchive,
    private readonly packetPrefix: string,
    public readonly packetRootDisplay: string,
  ) {}

  private archiveName(relativePath: string): string {
    safePacketRelativePath(relativePath, 'Packet ZIP read path');
    return `${this.packetPrefix}/${relativePath}`;
  }

  async listEntries(): Promise<PacketEntry[]> {
    const prefix = `${this.packetPrefix}/`;
    return this.archive.fileNames()
      .filter(name => name.startsWith(prefix))
      .map(name => ({ relativePath: name.slice(prefix.length), size: this.archive.entrySize(name) }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async readBytes(relativePath: string, maxBytes = METADATA_MAX_BYTES): Promise<Buffer> {
    return await this.archive.readBytes(this.archiveName(relativePath), maxBytes);
  }

  async sha256(relativePath: string): Promise<string> {
    return await this.archive.sha256(this.archiveName(relativePath));
  }
}

async function discoverPacketSource(inputPath: string): Promise<PacketSource> {
  const input = resolve(inputPath);
  const inputStat = await lstat(input).catch(cause => {
    if (isEnoent(cause)) error('PACKET_NOT_FOUND', 'FAIL', `Selected input path does not exist: ${input}`);
    throw cause;
  });
  if (inputStat.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Selected input path is a symbolic link/reparse-like entry: ${input}`);
  if (inputStat.isDirectory()) {
    const roots = [...new Set(await discoverDirectoryPacketRoots(input))].sort((a, b) => a.localeCompare(b));
    if (roots.length === 0) error('PACKET_NOT_FOUND', 'FAIL', 'Selected directory contains no DATA_PACKET directory');
    if (roots.length > 1) error('AMBIGUOUS_PACKET_DISCOVERY', 'HOLD', `Selected directory contains ${roots.length} DATA_PACKET candidates`);
    return new DirectoryPacketSource(roots[0]!);
  }
  if (inputStat.isFile() && extname(input).toLowerCase() === '.zip') {
    const archive = await ZipArchive.load(input);
    const roots = new Set<string>();
    for (const fileName of archive.fileNames()) {
      const segments = fileName.split('/');
      const index = segments.indexOf('DATA_PACKET');
      if (index >= 0) roots.add(segments.slice(0, index + 1).join('/'));
    }
    const candidates = [...roots].sort((a, b) => a.localeCompare(b));
    if (candidates.length === 0) error('PACKET_NOT_FOUND', 'FAIL', 'Selected ZIP contains no DATA_PACKET directory');
    if (candidates.length > 1) error('AMBIGUOUS_PACKET_DISCOVERY', 'HOLD', `Selected ZIP contains ${candidates.length} DATA_PACKET candidates`);
    const prefix = candidates[0]!;
    return new ZipPacketSource(archive, prefix, `${input}::${prefix}`);
  }
  error('PACKET_NOT_FOUND', 'FAIL', 'Selected input must be a directory tree or a .zip file containing exactly one DATA_PACKET');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be a non-empty string`);
  return field;
}

function integerField(value: Record<string, unknown>, key: string, label: string, min = 0): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < min) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be an integer >= ${min}`);
  return field as number;
}

function booleanField(value: Record<string, unknown>, key: string, label: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be boolean`);
  return field;
}

function requireSha(value: string, label: string): string {
  try {
    assertSha256(value, label);
  } catch (cause) {
    error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', cause instanceof Error ? cause.message : String(cause));
  }
  return value;
}

function parseJson(bytes: Buffer, label: string, parseCode: LocalPacketFailureCode = 'MANIFEST_PARSE_FAIL'): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    error(parseCode, 'FAIL', `${label} JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function validateManifest(raw: unknown): DatasetPacketManifest {
  const value = object(raw, 'manifest');
  if (stringField(value, 'manifest_schema_version', 'manifest') !== DATASET_PACKET_MANIFEST_SCHEMA_VERSION) {
    error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Unsupported manifest_schema_version: ${String(value.manifest_schema_version)}`);
  }
  if (stringField(value, 'canonical_schema_version', 'manifest') !== CANONICAL_SCHEMA_VERSION) {
    error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Unsupported canonical_schema_version: ${String(value.canonical_schema_version)}`);
  }
  const datasetId = stringField(value, 'dataset_id', 'manifest');
  if (!new RegExp(`^${DATASET_ID_PREFIX}[0-9a-f]{64}$`).test(datasetId)) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Invalid accepted dataset_id shape: ${datasetId}`);
  const gitCommit = stringField(value, 'generator_git_commit', 'manifest');
  if (!/^[0-9a-f]{40,64}$/.test(gitCommit)) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', 'manifest.generator_git_commit is not an exact Git commit SHA');
  const symbol = stringField(value, 'symbol', 'manifest');
  if (!/^[A-Z0-9._-]+$/.test(symbol)) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Invalid manifest symbol: ${symbol}`);
  for (const key of ['requested_from_utc', 'requested_to_utc', 'generated_at_utc'] as const) {
    const timestamp = stringField(value, key, 'manifest');
    if (!timestamp.endsWith('Z') || !Number.isFinite(Date.parse(timestamp))) error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `manifest.${key} must be an ISO UTC timestamp`);
  }
  for (const key of ['source_hash_root', 'precision_evidence_sha256', 'canonical_logical_hash_root', 'parquet_file_hash_root', 'mt5_derivative_hash_root'] as const) {
    requireSha(stringField(value, key, 'manifest'), `manifest.${key}`);
  }
  integerField(value, 'tick_count_total', 'manifest', 0);
  integerField(value, 'canonical_file_count', 'manifest', 1);
  integerField(value, 'price_digits', 'manifest', 0);
  integerField(value, 'price_scale', 'manifest', 1);
  if (stringField(value, 'precision_status', 'manifest') !== 'VERIFIED') error('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', 'manifest.precision_status must be VERIFIED');
  if (stringField(value, 'integrity_status', 'manifest') !== 'PASS') error('INTEGRITY_NOT_ACCEPTED', 'FAIL', 'manifest.integrity_status must be PASS');
  if (booleanField(value, 'canonical_promotion_allowed', 'manifest') !== true) error('CANONICAL_PROMOTION_NOT_ALLOWED', 'FAIL', 'manifest.canonical_promotion_allowed must be true');
  stringField(value, 'source_run_id', 'manifest');
  return value as unknown as DatasetPacketManifest;
}

function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) error('SHA256SUMS_PARSE_FAIL', 'FAIL', `Invalid SHA256SUMS line: ${line}`);
    const path = safePacketRelativePath(match[2]!, 'SHA256SUMS path');
    if (path === 'SHA256SUMS.txt') error('SHA256SUMS_PARSE_FAIL', 'FAIL', 'SHA256SUMS.txt must not self-reference');
    if (sums.has(path)) error('SHA256SUMS_PARSE_FAIL', 'FAIL', `Duplicate SHA256SUMS path: ${path}`);
    sums.set(path, match[1]!);
  }
  if (sums.size === 0) error('SHA256SUMS_PARSE_FAIL', 'FAIL', 'SHA256SUMS.txt contains no file bindings');
  return sums;
}

function validateBindingObject(raw: unknown, label: string): PacketFileBinding {
  const value = object(raw, label);
  const dateUtc = stringField(value, 'date_utc', label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) error('DATASET_BINDING_MISMATCH', 'FAIL', `${label}.date_utc is invalid`);
  const path = safePacketRelativePath(stringField(value, 'path', label), `${label}.path`);
  const physicalSha = requireSha(stringField(value, 'physical_sha256', label), `${label}.physical_sha256`);
  const logicalSha = requireSha(stringField(value, 'canonical_logical_row_hash', label), `${label}.canonical_logical_row_hash`);
  const sourceSha = requireSha(stringField(value, 'source_snapshot_sha256', label), `${label}.source_snapshot_sha256`);
  return {
    date_utc: dateUtc,
    path,
    physical_sha256: physicalSha,
    file_size_bytes: integerField(value, 'file_size_bytes', label, 0),
    canonical_logical_row_hash: logicalSha,
    row_count: integerField(value, 'row_count', label, 0),
    source_snapshot_sha256: sourceSha,
  };
}

function validateCommonBinding(value: Record<string, unknown>, manifest: DatasetPacketManifest, label: string): void {
  const expected: Record<string, string | number> = {
    dataset_id: manifest.dataset_id,
    canonical_schema_version: manifest.canonical_schema_version,
    symbol: manifest.symbol,
    requested_from_utc: manifest.requested_from_utc,
    requested_to_utc: manifest.requested_to_utc,
    source_hash_root: manifest.source_hash_root,
    canonical_logical_hash_root: manifest.canonical_logical_hash_root,
    price_digits: manifest.price_digits,
    price_scale: manifest.price_scale,
  };
  for (const [key, wanted] of Object.entries(expected)) {
    if (value[key] !== wanted) error('DATASET_BINDING_MISMATCH', 'FAIL', `${label}.${key} does not match manifest authority`);
  }
  if (value.dataset_binding_status !== 'BOUND_P2_5_PACKET') error('DATASET_BINDING_MISMATCH', 'FAIL', `${label}.dataset_binding_status is not BOUND_P2_5_PACKET`);
}

async function validateBindings(
  source: PacketSource,
  entries: Map<string, PacketEntry>,
  sums: Map<string, string>,
  manifest: DatasetPacketManifest,
): Promise<void> {
  const numba = object(parseJson(await source.readBytes('numba/dataset.json'), 'numba/dataset.json'), 'numba/dataset.json');
  const mt5 = object(parseJson(await source.readBytes('mt5/symbol_contract.json'), 'mt5/symbol_contract.json'), 'mt5/symbol_contract.json');
  const integrity = object(parseJson(await source.readBytes('audit/integrity_report.json'), 'audit/integrity_report.json'), 'audit/integrity_report.json');
  const precision = object(parseJson(await source.readBytes('audit/precision_evidence.json'), 'audit/precision_evidence.json'), 'audit/precision_evidence.json');
  validateCommonBinding(numba, manifest, 'numba/dataset.json');
  validateCommonBinding(mt5, manifest, 'mt5/symbol_contract.json');

  const parquetRaw = numba.parquet_files;
  const mt5Raw = mt5.tick_files;
  if (!Array.isArray(parquetRaw) || parquetRaw.length === 0) error('DATASET_BINDING_MISMATCH', 'FAIL', 'numba/dataset.json.parquet_files must be non-empty');
  if (!Array.isArray(mt5Raw) || mt5Raw.length === 0) error('DATASET_BINDING_MISMATCH', 'FAIL', 'mt5/symbol_contract.json.tick_files must be non-empty');
  const parquetBindings = parquetRaw.map((item, index) => validateBindingObject(item, `numba.parquet_files[${index}]`));
  const mt5Bindings = mt5Raw.map((item, index) => validateBindingObject(item, `mt5.tick_files[${index}]`));
  if (parquetBindings.length !== manifest.canonical_file_count) error('DATASET_BINDING_MISMATCH', 'FAIL', 'manifest.canonical_file_count does not match Numba Parquet binding count');
  const rowTotal = parquetBindings.reduce((sum, item) => sum + item.row_count, 0);
  const mt5RowTotal = mt5Bindings.reduce((sum, item) => sum + item.row_count, 0);
  if (rowTotal !== manifest.tick_count_total || mt5RowTotal !== manifest.tick_count_total) error('DATASET_BINDING_MISMATCH', 'FAIL', 'Packet binding row totals do not match manifest.tick_count_total');

  const parquetRoot = hashEntriesRoot(parquetBindings.map(item => ({ key: item.path, sha256: item.physical_sha256 })));
  const mt5Root = hashEntriesRoot(mt5Bindings.map(item => ({ key: item.path, sha256: item.physical_sha256 })));
  const canonicalRoot = hashEntriesRoot(parquetBindings.map(item => ({ key: item.date_utc, sha256: item.canonical_logical_row_hash })));
  const mt5CanonicalRoot = hashEntriesRoot(mt5Bindings.map(item => ({ key: item.date_utc, sha256: item.canonical_logical_row_hash })));
  if (parquetRoot !== manifest.parquet_file_hash_root) error('DATASET_BINDING_MISMATCH', 'FAIL', 'Reverified Parquet physical hash root does not match manifest');
  if (mt5Root !== manifest.mt5_derivative_hash_root) error('DATASET_BINDING_MISMATCH', 'FAIL', 'Reverified MT5 physical hash root does not match manifest');
  if (canonicalRoot !== manifest.canonical_logical_hash_root || mt5CanonicalRoot !== manifest.canonical_logical_hash_root) {
    error('DATASET_BINDING_MISMATCH', 'FAIL', 'Reverified Canonical logical hash root does not match manifest for Numba/MT5');
  }

  const parquetByDate = new Map(parquetBindings.map(item => [item.date_utc, item]));
  const mt5ByDate = new Map(mt5Bindings.map(item => [item.date_utc, item]));
  if (parquetByDate.size !== parquetBindings.length || mt5ByDate.size !== mt5Bindings.length || parquetByDate.size !== mt5ByDate.size) {
    error('DATASET_BINDING_MISMATCH', 'FAIL', 'Packet contains duplicate or inconsistent UTC-day bindings');
  }
  for (const [date, parquet] of parquetByDate) {
    const mt5Binding = mt5ByDate.get(date);
    if (!mt5Binding || mt5Binding.canonical_logical_row_hash !== parquet.canonical_logical_row_hash || mt5Binding.source_snapshot_sha256 !== parquet.source_snapshot_sha256 || mt5Binding.row_count !== parquet.row_count) {
      error('DATASET_BINDING_MISMATCH', 'FAIL', `Numba/MT5 binding mismatch for ${date}`);
    }
  }

  for (const [kind, bindings] of [['Parquet', parquetBindings], ['MT5', mt5Bindings]] as const) {
    for (const binding of bindings) {
      const entry = entries.get(binding.path);
      if (!entry) error('PACKET_FILE_MISSING', 'FAIL', `${kind} binding file is missing: ${binding.path}`);
      if (entry.size !== binding.file_size_bytes) error('DATASET_BINDING_MISMATCH', 'FAIL', `${kind} binding file size mismatch: ${binding.path}`);
      if (sums.get(binding.path) !== binding.physical_sha256) error('DATASET_BINDING_MISMATCH', 'FAIL', `${kind} binding physical hash does not match SHA256SUMS: ${binding.path}`);
      if (kind === 'Parquet' && !binding.path.startsWith(`canonical/${manifest.symbol}/`)) error('DATASET_BINDING_MISMATCH', 'FAIL', `Unexpected Canonical binding path: ${binding.path}`);
      if (kind === 'MT5' && !binding.path.startsWith(`mt5/ticks/${manifest.symbol}/`)) error('DATASET_BINDING_MISMATCH', 'FAIL', `Unexpected MT5 binding path: ${binding.path}`);
    }
  }

  if (integrity.dataset_id !== manifest.dataset_id || integrity.source_hash_root !== manifest.source_hash_root || integrity.canonical_logical_hash_root !== manifest.canonical_logical_hash_root || integrity.parquet_file_hash_root !== manifest.parquet_file_hash_root || integrity.mt5_derivative_hash_root !== manifest.mt5_derivative_hash_root) {
    error('DATASET_BINDING_MISMATCH', 'FAIL', 'audit/integrity_report.json does not bind to manifest identity/hash authority');
  }
  if (integrity.integrity_status !== 'PASS' || integrity.hash_chain_status !== 'PASS') error('INTEGRITY_NOT_ACCEPTED', 'FAIL', 'audit/integrity_report.json is not PASS');
  if (integrity.canonical_promotion_allowed !== true) error('CANONICAL_PROMOTION_NOT_ALLOWED', 'FAIL', 'audit/integrity_report.json does not permit canonical promotion');
  if (integrity.precision_status !== 'VERIFIED' || integrity.precision_binding_verified !== true) error('INTEGRITY_NOT_ACCEPTED', 'FAIL', 'integrity precision binding is not VERIFIED/PASS');
  if (integrity.numba_binding_status !== 'BOUND_P2_5_PACKET' || integrity.mt5_binding_status !== 'BOUND_P2_5_PACKET') error('DATASET_BINDING_MISMATCH', 'FAIL', 'integrity report derivative binding status is not BOUND_P2_5_PACKET');

  if (precision.symbol !== manifest.symbol || precision.candidate_price_digits !== manifest.price_digits || precision.candidate_price_scale !== manifest.price_scale || precision.precision_status !== 'VERIFIED' || precision.exact_lattice_pass !== true || precision.bid_scaled_conversion_fail_count !== 0 || precision.ask_scaled_conversion_fail_count !== 0) {
    error('DATASET_BINDING_MISMATCH', 'FAIL', 'audit/precision_evidence.json does not match accepted manifest precision binding');
  }
  if (sums.get('audit/precision_evidence.json') !== manifest.precision_evidence_sha256) error('DATASET_BINDING_MISMATCH', 'FAIL', 'manifest.precision_evidence_sha256 does not match accepted Packet file bytes');

  const dailyText = (await source.readBytes('audit/canonical_daily_audit.jsonl')).toString('utf8');
  const dailyRows = dailyText.split(/\r?\n/).filter(Boolean).map((line, index) => object(parseJson(Buffer.from(line), `canonical_daily_audit line ${index + 1}`), `canonical_daily_audit line ${index + 1}`));
  if (dailyRows.length !== parquetBindings.length || integrity.canonical_daily_audit_count !== dailyRows.length || integrity.canonical_daily_pass_count !== dailyRows.length) {
    error('DATASET_BINDING_MISMATCH', 'FAIL', 'canonical daily audit counts do not match Packet bindings');
  }
  for (const row of dailyRows) {
    const date = stringField(row, 'date_utc', 'canonical_daily_audit');
    const binding = parquetByDate.get(date);
    if (!binding || row.symbol !== manifest.symbol || row.status !== 'PASS' || row.source_order_preservation !== 'PASS' || row.hash_chain_status !== 'PASS' || row.parquet_sha256 !== binding.physical_sha256 || row.canonical_logical_row_hash !== binding.canonical_logical_row_hash || row.source_snapshot_sha256 !== binding.source_snapshot_sha256 || row.source_tick_count !== binding.row_count || row.canonical_tick_count !== binding.row_count || row.bid_scaled_conversion_fail_count !== 0 || row.ask_scaled_conversion_fail_count !== 0) {
      error('DATASET_BINDING_MISMATCH', 'FAIL', `canonical daily audit does not match accepted binding for ${date}`);
    }
  }
}

async function registryFileStatus(localRoot: string): Promise<'NOT_PRESENT' | 'PRESENT_UNVERIFIED_P5_1'> {
  const absoluteRoot = resolve(localRoot);
  try {
    const rootStat = await lstat(absoluteRoot);
    if (rootStat.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Local HDH root is a symbolic link/reparse-like entry: ${absoluteRoot}`);
    if (!rootStat.isDirectory()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Local HDH root exists but is not a directory: ${absoluteRoot}`);
  } catch (cause) {
    if (!isEnoent(cause)) throw cause;
    return 'NOT_PRESENT';
  }
  const registryPath = resolve(absoluteRoot, 'registry', 'hdh_registry.sqlite');
  try {
    const registryStat = await lstat(registryPath);
    if (registryStat.isSymbolicLink()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Local registry path is a symbolic link/reparse-like entry: ${registryPath}`);
    if (!registryStat.isFile()) error('WINDOWS_PATH_UNSAFE', 'HOLD', `Local registry path exists but is not a regular file: ${registryPath}`);
    return 'PRESENT_UNVERIFIED_P5_1';
  } catch (cause) {
    if (isEnoent(cause)) return 'NOT_PRESENT';
    throw cause;
  }
}

export async function scanLocalDatasetPacket(inputPath: string, localRoot: string): Promise<LocalPacketScanResult> {
  if (!inputPath.trim()) error('PACKET_NOT_FOUND', 'FAIL', 'An explicit local input path is required');
  if (!localRoot.trim()) error('WINDOWS_PATH_UNSAFE', 'HOLD', 'An explicit local HDH root path is required');
  const absoluteInput = resolve(inputPath);
  const absoluteRoot = resolve(localRoot);
  const source = await discoverPacketSource(absoluteInput);
  const entryList = await source.listEntries();
  const entries = new Map(entryList.map(entry => [entry.relativePath, entry]));
  if (entries.size !== entryList.length) error('PACKET_INVENTORY_MISMATCH', 'FAIL', 'Packet contains duplicate relative file paths');

  for (const required of ['manifest.json', 'SHA256SUMS.txt', 'README.md', 'numba/dataset.json', 'mt5/symbol_contract.json', 'audit/precision_evidence.json', 'audit/canonical_daily_audit.jsonl', 'audit/integrity_report.json']) {
    if (!entries.has(required)) {
      if (required === 'manifest.json') error('MANIFEST_MISSING', 'FAIL', 'Packet root is missing manifest.json');
      if (required === 'SHA256SUMS.txt') error('SHA256SUMS_MISSING', 'FAIL', 'Packet root is missing SHA256SUMS.txt');
      error('PACKET_FILE_MISSING', 'FAIL', `Packet is missing required file: ${required}`);
    }
  }
  if (![...entries.keys()].some(path => path.startsWith('canonical/'))) error('PACKET_FILE_MISSING', 'FAIL', 'Packet contains no Canonical Parquet payload');
  if (![...entries.keys()].some(path => path.startsWith('mt5/ticks/'))) error('PACKET_FILE_MISSING', 'FAIL', 'Packet contains no MT5 derivative payload');

  const manifest = validateManifest(parseJson(await source.readBytes('manifest.json'), 'manifest.json'));
  const sumsText = (await source.readBytes('SHA256SUMS.txt')).toString('utf8');
  const sums = parseSha256Sums(sumsText);
  const expectedInventory = [...entries.keys()].filter(path => path !== 'SHA256SUMS.txt').sort((a, b) => a.localeCompare(b));
  const boundInventory = [...sums.keys()].sort((a, b) => a.localeCompare(b));
  for (const path of boundInventory) if (!entries.has(path)) error('PACKET_FILE_MISSING', 'FAIL', `SHA256SUMS binds a missing Packet file: ${path}`);
  if (JSON.stringify(expectedInventory) !== JSON.stringify(boundInventory)) {
    const untracked = expectedInventory.filter(path => !sums.has(path));
    const unexpectedBindings = boundInventory.filter(path => !entries.has(path));
    error('PACKET_INVENTORY_MISMATCH', 'FAIL', `Packet inventory does not exactly match SHA256SUMS coverage; untracked=${untracked.join(',') || 'NONE'} missing=${unexpectedBindings.join(',') || 'NONE'}`);
  }

  for (const [path, expectedSha] of sums) {
    const actualSha = await source.sha256(path);
    if (actualSha !== expectedSha) error('SHA256_MISMATCH', 'FAIL', `SHA-256 mismatch for ${path}`);
  }
  await validateBindings(source, entries, sums, manifest);

  const manifestSha256 = await source.sha256('manifest.json');
  const sha256sumsSha256 = await source.sha256('SHA256SUMS.txt');
  const registryStatus = await registryFileStatus(absoluteRoot);
  const intendedDestination = resolve(absoluteRoot, 'datasets', manifest.dataset_id, 'DATA_PACKET');
  assertContained(resolve(absoluteRoot, 'datasets'), intendedDestination);

  return {
    local_import_status: 'VALIDATED',
    mutation_performed: false,
    input_type: source.sourceType,
    input_path: absoluteInput,
    resolved_packet_root: source.packetRootDisplay,
    dataset_id: manifest.dataset_id,
    symbol: manifest.symbol,
    requested_from_utc: manifest.requested_from_utc,
    requested_to_utc: manifest.requested_to_utc,
    tick_count_total: manifest.tick_count_total,
    source_hash_root: manifest.source_hash_root,
    canonical_logical_hash_root: manifest.canonical_logical_hash_root,
    parquet_file_hash_root: manifest.parquet_file_hash_root,
    mt5_derivative_hash_root: manifest.mt5_derivative_hash_root,
    precision_status: manifest.precision_status,
    integrity_status: manifest.integrity_status,
    canonical_promotion_allowed: manifest.canonical_promotion_allowed,
    packet_file_count: entryList.length,
    packet_total_bytes: entryList.reduce((sum, entry) => sum + entry.size, 0),
    sha256sums_checked_files: sums.size,
    sha256_mismatch_count: 0,
    manifest_sha256: manifestSha256,
    sha256sums_sha256: sha256sumsSha256,
    registry_file_status: registryStatus,
    intended_destination_path: intendedDestination,
  };
}
