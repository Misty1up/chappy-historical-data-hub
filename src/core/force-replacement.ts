import { access, rename } from 'node:fs/promises';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function backupExistingFile(path: string, suffix = Date.now().toString(10)): Promise<string | null> {
  if (!(await exists(path))) return null;
  const backupPath = `${path}.backup-${suffix}`;
  await rename(path, backupPath);
  return backupPath;
}
