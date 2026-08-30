import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import type { BinaryBytes } from '../core/atomic-write.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DATASET_ID_PREFIX,
  DATASET_PACKET_MANIFEST_SCHEMA_VERSION,
  assertSha256,
  hashEntriesRoot,
} from '../packet/contract.js';
import type { DatasetPacketManifest, PacketFileBinding } from '../packet/types.js';

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
  | 'WINDOWS_PATH_UNSAFE';

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
  readBytes(relativePath: string, maxBytes?: number): Promise<BinaryBytes>;
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
}

const METADATA_MAX_BYTES = 16 * 1024 * 1024;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_EOCD_MAX_SEARCH = 65_557;
const decoder = new TextDecoder();

function fail(code: LocalPacketFailureCode, status: 'FAIL' | 'HOLD', message: string): never {
  throw new LocalPacketError(code, status, message);
}

function toBytes(value: ArrayLike<number>): BinaryBytes {
  return Uint8Array.from(value);
}

function concatBytes(parts: readonly BinaryBytes[], totalLength?: number): BinaryBytes {
  const length = totalLength ?? parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  if (offset !== length) throw new Error(`Binary concatenation length mismatch: expected=${length} actual=${offset}`);
  return out;
}

function u16(bytes: BinaryBytes, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes: BinaryBytes, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function isEnoent(value: unknown): boolean {
  return (value as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function safePacketRelativePath(value: string, label: string): string {
  if (!value || value.includes('\0') || isAbsolute(value) || value.startsWith('/') || value.startsWith('\\')) {
    fail('SHA256SUMS_PARSE_FAIL', 'FAIL', `${label} is not a safe Packet-relative path`);
  }
  if (value.includes('\\')) fail('SHA256SUMS_PARSE_FAIL', 'FAIL', `${label} must use accepted forward-slash logical paths`);
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..') || /^[A-Za-z]:/.test(value)) {
    fail('SHA256SUMS_PARSE_FAIL', 'FAIL', `${label} contains traversal or drive-qualified path content`);
  }
  return value;
}

function safeArchivePath(rawName: string): string {
  if (!rawName || rawName.includes('\0')) fail('UNSAFE_ARCHIVE_ENTRY', 'HOLD', 'ZIP entry has an empty or NUL-containing path');
  const normalized = rawName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    fail('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP entry is absolute or drive-qualified: ${rawName}`);
  }
  const body = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const segments = body.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP entry contains an unsafe path segment: ${rawName}`);
  }
  return body;
}

function assertContained(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const back = relative(resolvedRoot, resolvedCandidate);
  if (!back || back === '.' || back === '..' || back.startsWith('../') || back.startsWith('..\\') || isAbsolute(back)) {
    fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Path escapes or is not beneath the selected root: ${candidate}`);
  }
}

async function hashDirectoryFile(packetRoot: string, relativePath: string): Promise<string> {
  const absolute = resolve(packetRoot, relativePath);
  assertContained(packetRoot, absolute);
  const fileStat = await lstat(absolute).catch(cause => {
    if (isEnoent(cause)) fail('PACKET_FILE_MISSING', 'FAIL', `Packet file is missing: ${relativePath}`);
    throw cause;
  });
  if (fileStat.isSymbolicLink()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet contains a symbolic link/reparse-like entry: ${relativePath}`);
  if (!fileStat.isFile()) fail('PACKET_FILE_MISSING', 'FAIL', `Packet path is not a regular file: ${relativePath}`);
  const hash = createHash('sha256');
  const stream = createReadStream(absolute);
  for await (const chunk of stream) hash.update(toBytes(chunk as ArrayLike<number>));
  return hash.digest('hex');
}

async function walkPacketFiles(packetRoot: string, current = packetRoot): Promise<PacketEntry[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: PacketEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    assertContained(packetRoot, absolute);
    if (entry.isSymbolicLink()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet tree contains a symbolic link/reparse-like entry: ${absolute}`);
    if (entry.isDirectory()) {
      files.push(...await walkPacketFiles(packetRoot, absolute));
    } else if (entry.isFile()) {
      files.push({ relativePath: relative(packetRoot, absolute).replaceAll('\\', '/'), size: (await stat(absolute)).size });
    } else {
      fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet tree contains a non-regular filesystem entry: ${absolute}`);
    }
  }
  return files;
}

async function discoverDirectoryPacketRoots(current: string, roots: string[] = []): Promise<string[]> {
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Selected tree contains a symbolic link/reparse-like entry: ${current}`);
  if (!currentStat.isDirectory()) return roots;
  if (basename(current) === 'DATA_PACKET') roots.push(resolve(current));
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    if (entry.isSymbolicLink()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Selected tree contains a symbolic link/reparse-like entry: ${absolute}`);
    if (entry.isDirectory()) await discoverDirectoryPacketRoots(absolute, roots);
  }
  return roots;
}

class DirectoryPacketSource implements PacketSource {
  readonly sourceType = 'DIRECTORY' as const;
  constructor(public readonly packetRootDisplay: string) {}

  async listEntries(): Promise<PacketEntry[]> {
    return await walkPacketFiles(this.packetRootDisplay);
  }

  async readBytes(relativePath: string, maxBytes = METADATA_MAX_BYTES): Promise<BinaryBytes> {
    safePacketRelativePath(relativePath, 'Packet read path');
    const absolute = resolve(this.packetRootDisplay, relativePath);
    assertContained(this.packetRootDisplay, absolute);
    const fileStat = await lstat(absolute).catch(cause => {
      if (isEnoent(cause)) fail('PACKET_FILE_MISSING', 'FAIL', `Packet file is missing: ${relativePath}`);
      throw cause;
    });
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Packet metadata path is not a regular file: ${relativePath}`);
    if (fileStat.size > maxBytes) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Metadata file exceeds bounded read size: ${relativePath}`);
    return toBytes(await readFile(absolute));
  }

  async sha256(relativePath: string): Promise<string> {
    safePacketRelativePath(relativePath, 'Packet hash path');
    return await hashDirectoryFile(this.packetRootDisplay, relativePath);
  }
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<BinaryBytes> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error('Unexpected EOF while reading ZIP');
    offset += result.bytesRead;
  }
  return bytes;
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
      if (!zipStat.isFile()) fail('PACKET_NOT_FOUND', 'FAIL', `ZIP input is not a regular file: ${zipPath}`);
      if (zipStat.size < ZIP_EOCD_MIN_SIZE) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP is too small');
      const tailSize = Math.min(zipStat.size, ZIP_EOCD_MAX_SEARCH);
      const tail = await readExact(handle, zipStat.size - tailSize, tailSize);
      let eocd = -1;
      for (let index = tail.length - ZIP_EOCD_MIN_SIZE; index >= 0; index -= 1) {
        if (u32(tail, index) === 0x06054b50) { eocd = index; break; }
      }
      if (eocd < 0) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP end-of-central-directory record was not found');
      const diskNumber = u16(tail, eocd + 4);
      const centralDisk = u16(tail, eocd + 6);
      const entriesOnDisk = u16(tail, eocd + 8);
      const totalEntries = u16(tail, eocd + 10);
      const centralSize = u32(tail, eocd + 12);
      const centralOffset = u32(tail, eocd + 16);
      if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'Multi-disk ZIP archives are not supported');
      if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP64 metadata is not supported by P5.1');
      if (centralOffset + centralSize > zipStat.size) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP central directory is outside file bounds');
      const central = await readExact(handle, centralOffset, centralSize);
      const records = new Map<string, ZipEntryRecord>();
      let cursor = 0;
      for (let index = 0; index < totalEntries; index += 1) {
        if (cursor + 46 > central.length || u32(central, cursor) !== 0x02014b50) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'Malformed ZIP central directory entry');
        const flags = u16(central, cursor + 8);
        const compressionMethod = u16(central, cursor + 10);
        const compressedSize = u32(central, cursor + 20);
        const uncompressedSize = u32(central, cursor + 24);
        const nameLength = u16(central, cursor + 28);
        const extraLength = u16(central, cursor + 30);
        const commentLength = u16(central, cursor + 32);
        const externalAttributes = u32(central, cursor + 38);
        const localHeaderOffset = u32(central, cursor + 42);
        const recordLength = 46 + nameLength + extraLength + commentLength;
        if (cursor + recordLength > central.length) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', 'ZIP central directory entry exceeds bounds');
        const rawName = decoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
        const name = safeArchivePath(rawName);
        const unixMode = (externalAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) fail('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP contains symbolic-link entry: ${rawName}`);
        if ((flags & 0x1) !== 0) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `Encrypted ZIP entry is unsupported: ${rawName}`);
        if (compressionMethod !== 0 && compressionMethod !== 8) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `Unsupported ZIP compression method ${compressionMethod}: ${rawName}`);
        const directory = rawName.endsWith('/') || rawName.endsWith('\\') || (unixMode & 0o170000) === 0o040000;
        if (!directory) {
          if (records.has(name)) fail('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP contains duplicate normalized file path: ${name}`);
          records.set(name, { name, compressedSize, uncompressedSize, compressionMethod, flags, localHeaderOffset });
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

  entrySize(name: string): number {
    return this.record(name).uncompressedSize;
  }

  private record(name: string): ZipEntryRecord {
    const record = this.records.get(name);
    if (!record) fail('PACKET_FILE_MISSING', 'FAIL', `ZIP Packet file is missing: ${name}`);
    return record;
  }

  private async compressedRange(record: ZipEntryRecord): Promise<{ start: number; end: number }> {
    const handle = await open(this.zipPath, 'r');
    try {
      const header = await readExact(handle, record.localHeaderOffset, 30);
      if (u32(header, 0) !== 0x04034b50) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `Malformed ZIP local header: ${record.name}`);
      if (u16(header, 6) !== record.flags || u16(header, 8) !== record.compressionMethod) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `ZIP local/central metadata mismatch: ${record.name}`);
      const nameLength = u16(header, 26);
      const extraLength = u16(header, 28);
      const localName = decoder.decode(await readExact(handle, record.localHeaderOffset + 30, nameLength));
      if (safeArchivePath(localName) !== record.name) fail('UNSAFE_ARCHIVE_ENTRY', 'HOLD', `ZIP local/central path mismatch: ${record.name}`);
      const start = record.localHeaderOffset + 30 + nameLength + extraLength;
      return { start, end: start + record.compressedSize - 1 };
    } finally {
      await handle.close();
    }
  }

  private async chunks(record: ZipEntryRecord): Promise<BinaryBytes[]> {
    if (record.compressedSize === 0) return [];
    const { start, end } = await this.compressedRange(record);
    const source = createReadStream(this.zipPath, { start, end });
    const stream = record.compressionMethod === 0 ? source : source.pipe(createInflateRaw());
    const chunks: BinaryBytes[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const bytes = toBytes(chunk as ArrayLike<number>);
      chunks.push(bytes);
      total += bytes.length;
    }
    if (total !== record.uncompressedSize) fail('ZIP_FORMAT_UNSUPPORTED', 'HOLD', `ZIP uncompressed size mismatch: ${record.name}`);
    return chunks;
  }

  async readBytes(name: string, maxBytes = METADATA_MAX_BYTES): Promise<BinaryBytes> {
    const record = this.record(name);
    if (record.uncompressedSize > maxBytes) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Metadata ZIP entry exceeds bounded read size: ${name}`);
    return concatBytes(await this.chunks(record), record.uncompressedSize);
  }

  async sha256(name: string): Promise<string> {
    const record = this.record(name);
    const hash = createHash('sha256');
    for (const chunk of await this.chunks(record)) hash.update(chunk);
    return hash.digest('hex');
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
    safePacketRelativePath(relativePath, 'ZIP Packet path');
    return `${this.packetPrefix}/${relativePath}`;
  }

  async listEntries(): Promise<PacketEntry[]> {
    const prefix = `${this.packetPrefix}/`;
    return this.archive.fileNames()
      .filter(name => name.startsWith(prefix))
      .map(name => ({ relativePath: name.slice(prefix.length), size: this.archive.entrySize(name) }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async readBytes(relativePath: string, maxBytes = METADATA_MAX_BYTES): Promise<BinaryBytes> {
    return await this.archive.readBytes(this.archiveName(relativePath), maxBytes);
  }

  async sha256(relativePath: string): Promise<string> {
    return await this.archive.sha256(this.archiveName(relativePath));
  }
}

async function discoverPacketSource(inputPath: string): Promise<PacketSource> {
  const input = resolve(inputPath);
  const inputStat = await lstat(input).catch(cause => {
    if (isEnoent(cause)) fail('PACKET_NOT_FOUND', 'FAIL', `Selected input path does not exist: ${input}`);
    throw cause;
  });
  if (inputStat.isSymbolicLink()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Selected input path is a symbolic link/reparse-like entry: ${input}`);
  if (inputStat.isDirectory()) {
    const roots = [...new Set(await discoverDirectoryPacketRoots(input))].sort((a, b) => a.localeCompare(b));
    if (roots.length === 0) fail('PACKET_NOT_FOUND', 'FAIL', 'Selected directory contains no DATA_PACKET directory');
    if (roots.length > 1) fail('AMBIGUOUS_PACKET_DISCOVERY', 'HOLD', `Selected directory contains ${roots.length} DATA_PACKET candidates`);
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
    if (candidates.length === 0) fail('PACKET_NOT_FOUND', 'FAIL', 'Selected ZIP contains no DATA_PACKET directory');
    if (candidates.length > 1) fail('AMBIGUOUS_PACKET_DISCOVERY', 'HOLD', `Selected ZIP contains ${candidates.length} DATA_PACKET candidates`);
    return new ZipPacketSource(archive, candidates[0]!, `${input}::${candidates[0]!}`);
  }
  fail('PACKET_NOT_FOUND', 'FAIL', 'Selected input must be a directory tree or .zip containing exactly one DATA_PACKET');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be a non-empty string`);
  return field;
}

function intField(value: Record<string, unknown>, key: string, label: string, min = 0): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < min) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be an integer >= ${min}`);
  return field as number;
}

function boolField(value: Record<string, unknown>, key: string, label: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be boolean`);
  return field;
}

function requireSha(value: string, label: string): string {
  try { assertSha256(value, label); } catch (cause) {
    fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', cause instanceof Error ? cause.message : String(cause));
  }
  return value;
}

function parseJson(bytes: BinaryBytes, label: string): unknown {
  try { return JSON.parse(decoder.decode(bytes)) as unknown; } catch (cause) {
    fail('MANIFEST_PARSE_FAIL', 'FAIL', `${label} JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function validateManifest(raw: unknown): DatasetPacketManifest {
  const value = object(raw, 'manifest');
  if (stringField(value, 'manifest_schema_version', 'manifest') !== DATASET_PACKET_MANIFEST_SCHEMA_VERSION) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', 'Unsupported manifest schema version');
  if (stringField(value, 'canonical_schema_version', 'manifest') !== CANONICAL_SCHEMA_VERSION) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', 'Unsupported canonical schema version');
  const datasetId = stringField(value, 'dataset_id', 'manifest');
  if (!new RegExp(`^${DATASET_ID_PREFIX}[0-9a-f]{64}$`).test(datasetId)) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `Invalid dataset_id shape: ${datasetId}`);
  if (!/^[0-9a-f]{40,64}$/.test(stringField(value, 'generator_git_commit', 'manifest'))) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', 'Invalid generator Git commit');
  if (!/^[A-Z0-9._-]+$/.test(stringField(value, 'symbol', 'manifest'))) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', 'Invalid manifest symbol');
  for (const key of ['requested_from_utc', 'requested_to_utc', 'generated_at_utc'] as const) {
    const timestamp = stringField(value, key, 'manifest');
    if (!timestamp.endsWith('Z') || !Number.isFinite(Date.parse(timestamp))) fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', `manifest.${key} must be ISO UTC`);
  }
  for (const key of ['source_hash_root', 'precision_evidence_sha256', 'canonical_logical_hash_root', 'parquet_file_hash_root', 'mt5_derivative_hash_root'] as const) requireSha(stringField(value, key, 'manifest'), `manifest.${key}`);
  intField(value, 'tick_count_total', 'manifest');
  intField(value, 'canonical_file_count', 'manifest', 1);
  intField(value, 'price_digits', 'manifest');
  intField(value, 'price_scale', 'manifest', 1);
  stringField(value, 'source_run_id', 'manifest');
  if (stringField(value, 'precision_status', 'manifest') !== 'VERIFIED') fail('MANIFEST_CONTRACT_UNSUPPORTED', 'HOLD', 'manifest.precision_status must be VERIFIED');
  if (stringField(value, 'integrity_status', 'manifest') !== 'PASS') fail('INTEGRITY_NOT_ACCEPTED', 'FAIL', 'manifest.integrity_status must be PASS');
  if (boolField(value, 'canonical_promotion_allowed', 'manifest') !== true) fail('CANONICAL_PROMOTION_NOT_ALLOWED', 'FAIL', 'manifest.canonical_promotion_allowed must be true');
  return value as unknown as DatasetPacketManifest;
}

function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail('SHA256SUMS_PARSE_FAIL', 'FAIL', `Invalid SHA256SUMS line: ${line}`);
    const path = safePacketRelativePath(match[2]!, 'SHA256SUMS path');
    if (path === 'SHA256SUMS.txt' || sums.has(path)) fail('SHA256SUMS_PARSE_FAIL', 'FAIL', `Invalid duplicate/self SHA256SUMS path: ${path}`);
    sums.set(path, match[1]!);
  }
  if (sums.size === 0) fail('SHA256SUMS_PARSE_FAIL', 'FAIL', 'SHA256SUMS.txt contains no bindings');
  return sums;
}

function binding(raw: unknown, label: string): PacketFileBinding {
  const value = object(raw, label);
  const dateUtc = stringField(value, 'date_utc', label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) fail('DATASET_BINDING_MISMATCH', 'FAIL', `${label}.date_utc is invalid`);
  return {
    date_utc: dateUtc,
    path: safePacketRelativePath(stringField(value, 'path', label), `${label}.path`),
    physical_sha256: requireSha(stringField(value, 'physical_sha256', label), `${label}.physical_sha256`),
    file_size_bytes: intField(value, 'file_size_bytes', label),
    canonical_logical_row_hash: requireSha(stringField(value, 'canonical_logical_row_hash', label), `${label}.canonical_logical_row_hash`),
    row_count: intField(value, 'row_count', label),
    source_snapshot_sha256: requireSha(stringField(value, 'source_snapshot_sha256', label), `${label}.source_snapshot_sha256`),
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
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) fail('DATASET_BINDING_MISMATCH', 'FAIL', `${label}.${key} does not match manifest authority`);
  if (value.dataset_binding_status !== 'BOUND_P2_5_PACKET') fail('DATASET_BINDING_MISMATCH', 'FAIL', `${label}.dataset_binding_status is invalid`);
}

async function validateBindings(source: PacketSource, entries: Map<string, PacketEntry>, sums: Map<string, string>, manifest: DatasetPacketManifest): Promise<void> {
  const numba = object(parseJson(await source.readBytes('numba/dataset.json'), 'numba/dataset.json'), 'numba/dataset.json');
  const mt5 = object(parseJson(await source.readBytes('mt5/symbol_contract.json'), 'mt5/symbol_contract.json'), 'mt5/symbol_contract.json');
  const integrity = object(parseJson(await source.readBytes('audit/integrity_report.json'), 'audit/integrity_report.json'), 'audit/integrity_report.json');
  const precision = object(parseJson(await source.readBytes('audit/precision_evidence.json'), 'audit/precision_evidence.json'), 'audit/precision_evidence.json');
  validateCommonBinding(numba, manifest, 'numba/dataset.json');
  validateCommonBinding(mt5, manifest, 'mt5/symbol_contract.json');

  if (!Array.isArray(numba.parquet_files) || !Array.isArray(mt5.tick_files)) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Numba/MT5 binding arrays are missing');
  const parquet = numba.parquet_files.map((item, index) => binding(item, `numba.parquet_files[${index}]`));
  const ticks = mt5.tick_files.map((item, index) => binding(item, `mt5.tick_files[${index}]`));
  if (parquet.length === 0 || ticks.length === 0 || parquet.length !== manifest.canonical_file_count || ticks.length !== parquet.length) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Packet binding file counts do not match manifest');
  if (parquet.reduce((sum, item) => sum + item.row_count, 0) !== manifest.tick_count_total || ticks.reduce((sum, item) => sum + item.row_count, 0) !== manifest.tick_count_total) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Packet binding row totals do not match manifest');

  const canonicalRoot = hashEntriesRoot(parquet.map(item => ({ key: item.date_utc, sha256: item.canonical_logical_row_hash })));
  const mt5CanonicalRoot = hashEntriesRoot(ticks.map(item => ({ key: item.date_utc, sha256: item.canonical_logical_row_hash })));
  const parquetRoot = hashEntriesRoot(parquet.map(item => ({ key: item.path, sha256: item.physical_sha256 })));
  const mt5Root = hashEntriesRoot(ticks.map(item => ({ key: item.path, sha256: item.physical_sha256 })));
  if (canonicalRoot !== manifest.canonical_logical_hash_root || mt5CanonicalRoot !== manifest.canonical_logical_hash_root || parquetRoot !== manifest.parquet_file_hash_root || mt5Root !== manifest.mt5_derivative_hash_root) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Reverified Packet binding roots do not match manifest authority');

  const parquetByDate = new Map(parquet.map(item => [item.date_utc, item]));
  const ticksByDate = new Map(ticks.map(item => [item.date_utc, item]));
  if (parquetByDate.size !== parquet.length || ticksByDate.size !== ticks.length) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Duplicate date binding detected');
  for (const [date, item] of parquetByDate) {
    const mt5Item = ticksByDate.get(date);
    if (!mt5Item || mt5Item.row_count !== item.row_count || mt5Item.source_snapshot_sha256 !== item.source_snapshot_sha256 || mt5Item.canonical_logical_row_hash !== item.canonical_logical_row_hash) fail('DATASET_BINDING_MISMATCH', 'FAIL', `Numba/MT5 binding mismatch for ${date}`);
  }
  for (const [kind, items] of [['Parquet', parquet], ['MT5', ticks]] as const) {
    for (const item of items) {
      if (!entries.has(item.path)) fail('PACKET_FILE_MISSING', 'FAIL', `${kind} binding file is missing: ${item.path}`);
      if (entries.get(item.path)!.size !== item.file_size_bytes || sums.get(item.path) !== item.physical_sha256) fail('DATASET_BINDING_MISMATCH', 'FAIL', `${kind} physical binding mismatch: ${item.path}`);
      if (kind === 'Parquet' && !item.path.startsWith(`canonical/${manifest.symbol}/`)) fail('DATASET_BINDING_MISMATCH', 'FAIL', `Unexpected Canonical path: ${item.path}`);
      if (kind === 'MT5' && !item.path.startsWith(`mt5/ticks/${manifest.symbol}/`)) fail('DATASET_BINDING_MISMATCH', 'FAIL', `Unexpected MT5 path: ${item.path}`);
    }
  }

  if (integrity.dataset_id !== manifest.dataset_id || integrity.source_hash_root !== manifest.source_hash_root || integrity.canonical_logical_hash_root !== manifest.canonical_logical_hash_root || integrity.parquet_file_hash_root !== manifest.parquet_file_hash_root || integrity.mt5_derivative_hash_root !== manifest.mt5_derivative_hash_root) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Integrity report does not bind to manifest identity/hash authority');
  if (integrity.integrity_status !== 'PASS' || integrity.hash_chain_status !== 'PASS' || integrity.precision_status !== 'VERIFIED' || integrity.precision_binding_verified !== true) fail('INTEGRITY_NOT_ACCEPTED', 'FAIL', 'Integrity report is not accepted PASS/VERIFIED');
  if (integrity.canonical_promotion_allowed !== true) fail('CANONICAL_PROMOTION_NOT_ALLOWED', 'FAIL', 'Integrity report does not allow Canonical promotion');
  if (integrity.numba_binding_status !== 'BOUND_P2_5_PACKET' || integrity.mt5_binding_status !== 'BOUND_P2_5_PACKET') fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Integrity derivative binding status is invalid');
  if (precision.symbol !== manifest.symbol || precision.candidate_price_digits !== manifest.price_digits || precision.candidate_price_scale !== manifest.price_scale || precision.precision_status !== 'VERIFIED' || precision.exact_lattice_pass !== true || precision.bid_scaled_conversion_fail_count !== 0 || precision.ask_scaled_conversion_fail_count !== 0) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Precision evidence does not match manifest binding');
  if (sums.get('audit/precision_evidence.json') !== manifest.precision_evidence_sha256) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Precision evidence bytes do not match manifest binding');

  const dailyRows = decoder.decode(await source.readBytes('audit/canonical_daily_audit.jsonl')).split(/\r?\n/).filter(Boolean).map((line, index) => object(parseJson(toBytes(new TextEncoder().encode(line)), `daily audit line ${index + 1}`), `daily audit line ${index + 1}`));
  if (dailyRows.length !== parquet.length || integrity.canonical_daily_audit_count !== dailyRows.length || integrity.canonical_daily_pass_count !== dailyRows.length) fail('DATASET_BINDING_MISMATCH', 'FAIL', 'Canonical daily audit counts do not match Packet');
  for (const row of dailyRows) {
    const date = stringField(row, 'date_utc', 'canonical_daily_audit');
    const item = parquetByDate.get(date);
    if (!item || row.symbol !== manifest.symbol || row.status !== 'PASS' || row.source_order_preservation !== 'PASS' || row.hash_chain_status !== 'PASS' || row.parquet_sha256 !== item.physical_sha256 || row.canonical_logical_row_hash !== item.canonical_logical_row_hash || row.source_snapshot_sha256 !== item.source_snapshot_sha256 || row.source_tick_count !== item.row_count || row.canonical_tick_count !== item.row_count || row.bid_scaled_conversion_fail_count !== 0 || row.ask_scaled_conversion_fail_count !== 0) fail('DATASET_BINDING_MISMATCH', 'FAIL', `Canonical daily audit mismatch for ${date}`);
  }
}

async function registryFileStatus(localRoot: string): Promise<'NOT_PRESENT' | 'PRESENT_UNVERIFIED_P5_1'> {
  const root = resolve(localRoot);
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Local HDH root is unsafe: ${root}`);
  } catch (cause) {
    if (isEnoent(cause)) return 'NOT_PRESENT';
    throw cause;
  }
  const registry = resolve(root, 'registry', 'hdh_registry.sqlite');
  try {
    const registryStat = await lstat(registry);
    if (registryStat.isSymbolicLink() || !registryStat.isFile()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', `Local registry path is unsafe: ${registry}`);
    return 'PRESENT_UNVERIFIED_P5_1';
  } catch (cause) {
    if (isEnoent(cause)) return 'NOT_PRESENT';
    throw cause;
  }
}

export async function scanLocalDatasetPacket(inputPath: string, localRoot: string): Promise<LocalPacketScanResult> {
  if (!inputPath.trim()) fail('PACKET_NOT_FOUND', 'FAIL', 'Explicit local input path is required');
  if (!localRoot.trim()) fail('WINDOWS_PATH_UNSAFE', 'HOLD', 'Explicit local HDH root is required');
  const absoluteInput = resolve(inputPath);
  const absoluteRoot = resolve(localRoot);
  const source = await discoverPacketSource(absoluteInput);
  const entryList = await source.listEntries();
  const entries = new Map(entryList.map(entry => [entry.relativePath, entry]));
  if (entries.size !== entryList.length) fail('PACKET_INVENTORY_MISMATCH', 'FAIL', 'Packet contains duplicate relative file paths');
  for (const required of ['manifest.json', 'SHA256SUMS.txt', 'README.md', 'numba/dataset.json', 'mt5/symbol_contract.json', 'audit/precision_evidence.json', 'audit/canonical_daily_audit.jsonl', 'audit/integrity_report.json']) {
    if (!entries.has(required)) {
      if (required === 'manifest.json') fail('MANIFEST_MISSING', 'FAIL', 'Packet root is missing manifest.json');
      if (required === 'SHA256SUMS.txt') fail('SHA256SUMS_MISSING', 'FAIL', 'Packet root is missing SHA256SUMS.txt');
      fail('PACKET_FILE_MISSING', 'FAIL', `Packet is missing required file: ${required}`);
    }
  }
  if (![...entries.keys()].some(path => path.startsWith('canonical/'))) fail('PACKET_FILE_MISSING', 'FAIL', 'Packet contains no Canonical payload');
  if (![...entries.keys()].some(path => path.startsWith('mt5/ticks/'))) fail('PACKET_FILE_MISSING', 'FAIL', 'Packet contains no MT5 derivative payload');

  const manifest = validateManifest(parseJson(await source.readBytes('manifest.json'), 'manifest.json'));
  const sums = parseSha256Sums(decoder.decode(await source.readBytes('SHA256SUMS.txt')));
  const expectedInventory = [...entries.keys()].filter(path => path !== 'SHA256SUMS.txt').sort((a, b) => a.localeCompare(b));
  const coveredInventory = [...sums.keys()].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(expectedInventory) !== JSON.stringify(coveredInventory)) fail('PACKET_INVENTORY_MISMATCH', 'FAIL', 'Packet inventory does not exactly match SHA256SUMS coverage');
  for (const [path, expectedSha] of sums) {
    if (!entries.has(path)) fail('PACKET_FILE_MISSING', 'FAIL', `SHA256SUMS binds a missing file: ${path}`);
    if (await source.sha256(path) !== expectedSha) fail('SHA256_MISMATCH', 'FAIL', `SHA-256 mismatch for ${path}`);
  }
  await validateBindings(source, entries, sums, manifest);

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
    manifest_sha256: await source.sha256('manifest.json'),
    sha256sums_sha256: await source.sha256('SHA256SUMS.txt'),
    registry_file_status: registryStatus,
    intended_destination_path: intendedDestination,
  };
}
