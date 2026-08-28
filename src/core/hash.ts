import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { BinaryBytes } from './atomic-write.js';

function toBinaryBytes(data: Uint8Array): BinaryBytes {
  return new Uint8Array(data);
}

export function sha256Buffer(data: Uint8Array): string {
  return createHash('sha256').update(toBinaryBytes(data)).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(toBinaryBytes(chunk)));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
