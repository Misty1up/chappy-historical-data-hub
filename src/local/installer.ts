import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import {
  LocalPacketError,
  scanLocalDatasetPacket,
  type LocalPacketScanResult,
} from './packet-verifier.js';

export type LocalInstallFailureCode =
  | 'DATASET_ID_COLLISION_OR_LOCAL_CORRUPTION'
  | 'DESTINATION_ALREADY_EXISTS_UNEXPECTED'
  | 'LOCAL_REGISTRY_INCONSISTENT'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'STAGING_VERIFY_FAIL'
  | 'ATOMIC_PUBLISH_FAIL'
  | 'WINDOWS_PATH_UNSAFE';

export class LocalInstallError extends Error {
  constructor(
    public readonly code: LocalInstallFailureCode,
    public readonly status: 'FAIL' | 'HOLD',
    message: string,
    public readonly causeCode: string | null = null,
  ) {
    super(message);
    this.name = 'LocalInstallError';
  }
}

export interface LocalInstallResult {
  local_import_status: 'IMPORTED' | 'ALREADY_REGISTERED';
  mutation_performed: boolean;
  dataset_id: string;
  input_type: 'DIRECTORY' | 'ZIP';
  input_path: string;
  final_packet_path: string;
  import_run_id: string | null;
  packet_file_count: number;
  packet_total_bytes: number;
  sha256sums_sha256: string;
  registry_mutation_performed: false;
}

/** Test-only fault injection. Hooks can only add faults; they cannot bypass validation gates. */
export interface LocalInstallerTestHooks {
  afterMaterialize?: (stagingPacketRoot: string) => Promise<void>;
}

interface ZipRecord {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  flags: number;
  localHeaderOffset: number;
}

const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_EOCD_MAX_SEARCH = 65_557;
const decoder = new TextDecoder();

function installError(
  code: LocalInstallFailureCode,
  status: 'FAIL' | 'HOLD',
  message: string,
  causeCode: string | null = null,
): never {
  throw new LocalInstallError(code, status, message, causeCode);
}

function isEnoent(value: unknown): boolean {
  return (value as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function pathIsInside(parent: string, child: string): boolean {
  const back = relative(resolve(parent), resolve(child));
  return back !== '' && back !== '.' && back !== '..' && !back.startsWith('../') && !back.startsWith('..\\') && !isAbsolute(back);
}

function assertContained(root: string, candidate: string): void {
  const back = relative(resolve(root), resolve(candidate));
  if (!back || back === '.' || back === '..' || back.startsWith('../') || back.startsWith('..\\') || isAbsolute(back)) {
    installError('WINDOWS_PATH_UNSAFE', 'HOLD', `Path is not safely contained beneath root: ${candidate}`);
  }
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isEnoent(cause)) return null;
    throw cause;
  }
}

async function requireOrdinaryDirectory(path: string, label: string): Promise<void> {
  const entry = await pathStat(path);
  if (!entry) return;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    installError('WINDOWS_PATH_UNSAFE', 'HOLD', `${label} must be an ordinary directory: ${path}`);
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let cursor = resolve(path);
  for (;;) {
    if (await pathStat(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) installError('WINDOWS_PATH_UNSAFE', 'HOLD', `No existing filesystem ancestor for local root: ${path}`);
    cursor = parent;
  }
}

async function requireFreeSpace(localRoot: string, requiredBytes: number): Promise<void> {
  const anchor = await nearestExistingAncestor(localRoot);
  const fs = await statfs(anchor);
  const available = fs.bavail * fs.bsize;
  if (!Number.isFinite(available) || available < requiredBytes) {
    installError(
      'INSUFFICIENT_DISK_SPACE',
      'HOLD',
      `Insufficient free space for staged Packet copy: required=${requiredBytes} available=${available}`,
    );
  }
}

function scansEquivalent(left: LocalPacketScanResult, right: LocalPacketScanResult): boolean {
  return left.dataset_id === right.dataset_id
    && left.sha256sums_sha256 === right.sha256sums_sha256
    && left.manifest_sha256 === right.manifest_sha256
    && left.packet_file_count === right.packet_file_count
    && left.packet_total_bytes === right.packet_total_bytes;
}

async function scanExistingFinal(
  candidate: LocalPacketScanResult,
  localRoot: string,
): Promise<LocalInstallResult | null> {
  const finalPacket = candidate.intended_destination_path;
  const finalDatasetRoot = dirname(finalPacket);
  const datasetEntry = await pathStat(finalDatasetRoot);
  if (!datasetEntry) return null;
  if (datasetEntry.isSymbolicLink() || !datasetEntry.isDirectory()) {
    installError('DESTINATION_ALREADY_EXISTS_UNEXPECTED', 'HOLD', `Dataset destination is not an ordinary directory: ${finalDatasetRoot}`);
  }
  const finalEntry = await pathStat(finalPacket);
  if (!finalEntry) {
    installError('DESTINATION_ALREADY_EXISTS_UNEXPECTED', 'HOLD', `Dataset destination exists without DATA_PACKET: ${finalDatasetRoot}`);
  }
  if (finalEntry.isSymbolicLink() || !finalEntry.isDirectory()) {
    installError('DATASET_ID_COLLISION_OR_LOCAL_CORRUPTION', 'FAIL', `Existing DATA_PACKET is not an ordinary directory: ${finalPacket}`);
  }

  let existing: LocalPacketScanResult;
  try {
    existing = await scanLocalDatasetPacket(finalPacket, localRoot);
  } catch (cause) {
    if (cause instanceof LocalPacketError) {
      installError(
        'DATASET_ID_COLLISION_OR_LOCAL_CORRUPTION',
        'FAIL',
        `Existing destination Packet is invalid: ${cause.code}: ${cause.message}`,
        cause.code,
      );
    }
    throw cause;
  }
  if (!scansEquivalent(candidate, existing)) {
    installError(
      'DATASET_ID_COLLISION_OR_LOCAL_CORRUPTION',
      'FAIL',
      `Existing destination for ${candidate.dataset_id} is not byte/hash equivalent to candidate`,
    );
  }
  return {
    local_import_status: 'ALREADY_REGISTERED',
    mutation_performed: false,
    dataset_id: candidate.dataset_id,
    input_type: candidate.input_type,
    input_path: candidate.input_path,
    final_packet_path: finalPacket,
    import_run_id: null,
    packet_file_count: candidate.packet_file_count,
    packet_total_bytes: candidate.packet_total_bytes,
    sha256sums_sha256: candidate.sha256sums_sha256,
    registry_mutation_performed: false,
  };
}

async function copyDirectoryPacket(sourceRoot: string, destinationRoot: string): Promise<void> {
  const source = await lstat(sourceRoot);
  if (source.isSymbolicLink() || !source.isDirectory()) {
    installError('WINDOWS_PATH_UNSAFE', 'HOLD', `Directory Packet source is not an ordinary directory: ${sourceRoot}`);
  }
  await mkdir(destinationRoot, { recursive: false });

  async function copyTree(currentSource: string, currentDestination: string): Promise<void> {
    for (const entry of (await readdir(currentSource, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = resolve(currentSource, entry.name);
      const destinationPath = resolve(currentDestination, entry.name);
      assertContained(sourceRoot, sourcePath);
      assertContained(destinationRoot, destinationPath);
      const actual = await lstat(sourcePath);
      if (actual.isSymbolicLink()) installError('WINDOWS_PATH_UNSAFE', 'HOLD', `Source Packet changed to symbolic link during copy: ${sourcePath}`);
      if (actual.isDirectory()) {
        await mkdir(destinationPath, { recursive: false });
        await copyTree(sourcePath, destinationPath);
      } else if (actual.isFile()) {
        await copyFile(sourcePath, destinationPath);
      } else {
        installError('WINDOWS_PATH_UNSAFE', 'HOLD', `Source Packet contains unsupported filesystem entry: ${sourcePath}`);
      }
    }
  }

  await copyTree(sourceRoot, destinationRoot);
}

function u16(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array<ArrayBuffer>(new ArrayBuffer(length));
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error('Unexpected EOF while reading ZIP');
    offset += result.bytesRead;
  }
  return bytes;
}

function safeArchivePath(rawName: string): string {
  if (!rawName || rawName.includes('\0')) installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'ZIP entry has an empty or NUL-containing path');
  const normalized = rawName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP entry is absolute or drive-qualified: ${rawName}`);
  }
  const body = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (body.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP entry contains traversal content: ${rawName}`);
  }
  return body;
}

class InstallZipArchive {
  private constructor(
    private readonly zipPath: string,
    private readonly records: Map<string, ZipRecord>,
  ) {}

  static async load(zipPath: string): Promise<InstallZipArchive> {
    const handle = await open(zipPath, 'r');
    try {
      const zipStat = await handle.stat();
      if (!zipStat.isFile() || zipStat.size < ZIP_EOCD_MIN_SIZE) {
        installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP input is not a supported ordinary archive: ${zipPath}`);
      }
      const tailSize = Math.min(zipStat.size, ZIP_EOCD_MAX_SEARCH);
      const tail = await readExact(handle, zipStat.size - tailSize, tailSize);
      let eocd = -1;
      for (let index = tail.length - ZIP_EOCD_MIN_SIZE; index >= 0; index -= 1) {
        if (u32(tail, index) === 0x06054b50) { eocd = index; break; }
      }
      if (eocd < 0) installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'ZIP end-of-central-directory record was not found');
      const diskNumber = u16(tail, eocd + 4);
      const centralDisk = u16(tail, eocd + 6);
      const entriesOnDisk = u16(tail, eocd + 8);
      const totalEntries = u16(tail, eocd + 10);
      const centralSize = u32(tail, eocd + 12);
      const centralOffset = u32(tail, eocd + 16);
      if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
        installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'Multi-disk ZIP archives are not supported');
      }
      if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'ZIP64 metadata is not supported by the Phase 5 MVP');
      }
      if (centralOffset + centralSize > zipStat.size) installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'ZIP central directory exceeds file bounds');
      const central = await readExact(handle, centralOffset, centralSize);
      const records = new Map<string, ZipRecord>();
      let cursor = 0;
      for (let index = 0; index < totalEntries; index += 1) {
        if (cursor + 46 > central.length || u32(central, cursor) !== 0x02014b50) {
          installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'Malformed ZIP central directory');
        }
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
        if (cursor + recordLength > central.length) installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'ZIP central entry exceeds bounds');
        const rawName = decoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
        const name = safeArchivePath(rawName);
        const unixMode = (externalAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP symbolic-link entry refused: ${rawName}`);
        if ((flags & 0x1) !== 0 || (compressionMethod !== 0 && compressionMethod !== 8)) {
          installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP entry uses unsupported encryption/compression: ${rawName}`);
        }
        const directory = rawName.endsWith('/') || rawName.endsWith('\\') || (unixMode & 0o170000) === 0o040000;
        if (!directory) {
          if (records.has(name)) installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP contains duplicate normalized file path: ${name}`);
          records.set(name, { name, compressedSize, uncompressedSize, compressionMethod, flags, localHeaderOffset });
        }
        cursor += recordLength;
      }
      return new InstallZipArchive(resolve(zipPath), records);
    } finally {
      await handle.close();
    }
  }

  private record(name: string): ZipRecord {
    const record = this.records.get(name);
    if (!record) installError('STAGING_VERIFY_FAIL', 'FAIL', `Validated ZIP entry disappeared: ${name}`);
    return record;
  }

  private async compressedRange(record: ZipRecord): Promise<{ start: number; end: number }> {
    const handle = await open(this.zipPath, 'r');
    try {
      const header = await readExact(handle, record.localHeaderOffset, 30);
      if (u32(header, 0) !== 0x04034b50) installError('WINDOWS_PATH_UNSAFE', 'HOLD', `Malformed ZIP local header: ${record.name}`);
      if (u16(header, 6) !== record.flags || u16(header, 8) !== record.compressionMethod) {
        installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP local/central metadata mismatch: ${record.name}`);
      }
      const nameLength = u16(header, 26);
      const extraLength = u16(header, 28);
      const localName = decoder.decode(await readExact(handle, record.localHeaderOffset + 30, nameLength));
      if (safeArchivePath(localName) !== record.name) installError('WINDOWS_PATH_UNSAFE', 'HOLD', `ZIP local/central path mismatch: ${record.name}`);
      const start = record.localHeaderOffset + 30 + nameLength + extraLength;
      return { start, end: start + record.compressedSize - 1 };
    } finally {
      await handle.close();
    }
  }

  fileNames(): string[] {
    return [...this.records.keys()].sort((a, b) => a.localeCompare(b));
  }

  async copyEntry(name: string, destination: string): Promise<void> {
    const record = this.record(name);
    await mkdir(dirname(destination), { recursive: true });
    if (record.compressedSize === 0) {
      await pipeline(createReadStream('/dev/null'), createWriteStream(destination));
      return;
    }
    const { start, end } = await this.compressedRange(record);
    const source = createReadStream(this.zipPath, { start, end });
    const input = record.compressionMethod === 0 ? source : source.pipe(createInflateRaw());
    await pipeline(input, createWriteStream(destination, { flags: 'wx' }));
    const output = await stat(destination);
    if (!output.isFile() || output.size !== record.uncompressedSize) {
      installError('STAGING_VERIFY_FAIL', 'FAIL', `ZIP materialized size mismatch: ${name}`);
    }
  }
}

function zipPrefix(scan: LocalPacketScanResult): string {
  const marker = `${scan.input_path}::`;
  if (!scan.resolved_packet_root.startsWith(marker)) {
    installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'Validated ZIP Packet root is not bound to selected input path');
  }
  const prefix = scan.resolved_packet_root.slice(marker.length);
  safeArchivePath(prefix);
  return prefix;
}

async function copyZipPacket(scan: LocalPacketScanResult, destinationRoot: string): Promise<void> {
  const archive = await InstallZipArchive.load(scan.input_path);
  const prefix = `${zipPrefix(scan)}/`;
  const names = archive.fileNames().filter(name => name.startsWith(prefix)).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) installError('STAGING_VERIFY_FAIL', 'FAIL', 'Validated ZIP Packet contains no files during materialization');
  await mkdir(destinationRoot, { recursive: false });
  for (const name of names) {
    const relativePath = name.slice(prefix.length);
    if (!relativePath || relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      installError('WINDOWS_PATH_UNSAFE', 'HOLD', `Unsafe ZIP Packet relative path during materialization: ${name}`);
    }
    const destination = resolve(destinationRoot, relativePath);
    assertContained(destinationRoot, destination);
    await archive.copyEntry(name, destination);
  }
}

async function ensureLocalRootSafe(scan: LocalPacketScanResult, localRoot: string): Promise<void> {
  const root = resolve(localRoot);
  if (scan.input_type === 'DIRECTORY' && (root === scan.input_path || pathIsInside(scan.input_path, root))) {
    installError('WINDOWS_PATH_UNSAFE', 'HOLD', 'Local HDH root must not be created inside the selected source directory tree');
  }
  await requireOrdinaryDirectory(root, 'Local HDH root');
  const staging = resolve(root, '.staging');
  const datasets = resolve(root, 'datasets');
  await requireOrdinaryDirectory(staging, 'Staging root');
  await requireOrdinaryDirectory(datasets, 'Datasets root');
  assertContained(root, staging);
  assertContained(root, datasets);
}

async function ensureNoRegistry(scan: LocalPacketScanResult): Promise<void> {
  if (scan.registry_file_status !== 'NOT_PRESENT') {
    installError(
      'LOCAL_REGISTRY_INCONSISTENT',
      'HOLD',
      'P5.2 must not interpret or mutate an existing SQLite registry; registry integration is gated to P5.3',
    );
  }
}

async function publishOrResolveRace(
  candidate: LocalPacketScanResult,
  localRoot: string,
  stagingRunRoot: string,
  finalDatasetRoot: string,
): Promise<'IMPORTED' | 'ALREADY_REGISTERED'> {
  try {
    await rename(stagingRunRoot, finalDatasetRoot);
    return 'IMPORTED';
  } catch (cause) {
    const raced = await scanExistingFinal(candidate, localRoot).catch(error => { throw error; });
    if (raced) {
      await rm(stagingRunRoot, { recursive: true, force: true }).catch(() => undefined);
      return 'ALREADY_REGISTERED';
    }
    installError(
      'ATOMIC_PUBLISH_FAIL',
      'FAIL',
      `Atomic dataset publish failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function importLocalDatasetPacket(
  inputPath: string,
  localRoot: string,
  hooks: LocalInstallerTestHooks = {},
): Promise<LocalInstallResult> {
  const root = resolve(localRoot);
  const candidate = await scanLocalDatasetPacket(inputPath, root);
  await ensureNoRegistry(candidate);
  await ensureLocalRootSafe(candidate, root);

  const existing = await scanExistingFinal(candidate, root);
  if (existing) return existing;

  await requireFreeSpace(root, candidate.packet_total_bytes);
  await mkdir(root, { recursive: true });
  await requireOrdinaryDirectory(root, 'Local HDH root');
  const stagingBase = resolve(root, '.staging');
  const datasetsBase = resolve(root, 'datasets');
  await mkdir(stagingBase, { recursive: true });
  await mkdir(datasetsBase, { recursive: true });
  await requireOrdinaryDirectory(stagingBase, 'Staging root');
  await requireOrdinaryDirectory(datasetsBase, 'Datasets root');

  const importRunId = randomUUID();
  const stagingRunRoot = resolve(stagingBase, importRunId);
  const stagingPacketRoot = resolve(stagingRunRoot, 'DATA_PACKET');
  const finalDatasetRoot = dirname(candidate.intended_destination_path);
  assertContained(stagingBase, stagingRunRoot);
  assertContained(datasetsBase, finalDatasetRoot);
  await mkdir(stagingRunRoot, { recursive: false });

  let published = false;
  try {
    if (candidate.input_type === 'DIRECTORY') {
      await copyDirectoryPacket(candidate.resolved_packet_root, stagingPacketRoot);
    } else {
      await copyZipPacket(candidate, stagingPacketRoot);
    }
    if (hooks.afterMaterialize) await hooks.afterMaterialize(stagingPacketRoot);

    let staged: LocalPacketScanResult;
    try {
      staged = await scanLocalDatasetPacket(stagingPacketRoot, root);
    } catch (cause) {
      if (cause instanceof LocalPacketError) {
        installError('STAGING_VERIFY_FAIL', 'FAIL', `Staged Packet failed validation: ${cause.code}: ${cause.message}`, cause.code);
      }
      throw cause;
    }
    if (!scansEquivalent(candidate, staged)) {
      installError('STAGING_VERIFY_FAIL', 'FAIL', 'Staged Packet does not exactly match the validated source candidate');
    }

    const lateExisting = await scanExistingFinal(candidate, root);
    if (lateExisting) return lateExisting;

    const publishStatus = await publishOrResolveRace(candidate, root, stagingRunRoot, finalDatasetRoot);
    published = publishStatus === 'IMPORTED';
    return {
      local_import_status: publishStatus,
      mutation_performed: publishStatus === 'IMPORTED',
      dataset_id: candidate.dataset_id,
      input_type: candidate.input_type,
      input_path: candidate.input_path,
      final_packet_path: candidate.intended_destination_path,
      import_run_id: publishStatus === 'IMPORTED' ? importRunId : null,
      packet_file_count: candidate.packet_file_count,
      packet_total_bytes: candidate.packet_total_bytes,
      sha256sums_sha256: candidate.sha256sums_sha256,
      registry_mutation_performed: false,
    };
  } finally {
    if (!published) await rm(stagingRunRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
