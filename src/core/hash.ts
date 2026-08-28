import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { BinaryBytes } from './atomic-write.js';

function toBinaryBytes(data: ArrayLike<number>): BinaryBytes {
  return Uint8Array.from(data);
}

export function sha256Buffer(data: ArrayLike<number>): string {
  return createHash('sha256').update(toBinaryBytes(data)).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => {
      const bytes = typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : toBinaryBytes(chunk);
      hash.update(bytes);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
