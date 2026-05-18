import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function listFilesSorted(dir: string): Promise<string[]> {
  await ensureDirectory(dir);
  const names = await readdir(dir);
  const withStats = await Promise.all(
    names.map(async (name) => ({
      name,
      stats: await stat(path.join(dir, name))
    }))
  );
  return withStats
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    .map((entry) => entry.name);
}
