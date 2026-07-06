import fs from 'node:fs/promises';
import path from 'node:path';

type PokemonCacheIndexes = Record<string, Record<string, string[]>>;
type SyncMeta = {
  syncedAt: string | null;
  provider: string;
  totalCards: number;
  totalSets: number;
  totalNames: number;
  languages: string[];
  warnings: string[];
  errors: string[];
};

const cacheDir = path.resolve(process.cwd(), 'server/data/pokemon');
const fileNames = [
  'pokemonCards.json',
  'pokemonSets.json',
  'pokemonNames.json',
  'pokemonIndexes.json',
  'syncMeta.json'
];

async function main() {
  const missing = await findMissingFiles();
  if (missing.length) {
    console.log('Pokemon metadata cache is missing files:');
    for (const fileName of missing) console.log(`- ${path.join(cacheDir, fileName)}`);
    console.log('\nRun npm run sync:pokemon to generate the cache.');
    process.exitCode = 1;
    return;
  }

  const [cards, sets, names, indexes, syncMeta] = await Promise.all([
    readJson<unknown[]>('pokemonCards.json'),
    readJson<unknown[]>('pokemonSets.json'),
    readJson<string[]>('pokemonNames.json'),
    readJson<PokemonCacheIndexes>('pokemonIndexes.json'),
    readJson<SyncMeta>('syncMeta.json')
  ]);

  const fileSizes = await Promise.all(
    fileNames.map(async (fileName) => {
      const stat = await fs.stat(path.join(cacheDir, fileName));
      return [fileName, formatBytes(stat.size)] as const;
    })
  );

  console.log('Pokemon metadata cache stats');
  console.log('----------------------------');
  console.log(`Cache dir: ${cacheDir}`);
  console.log(`Provider: ${syncMeta.provider}`);
  console.log(`Last synced: ${syncMeta.syncedAt ?? 'Never'}`);
  console.log(`Total cards: ${cards.length}`);
  console.log(`Total sets: ${sets.length}`);
  console.log(`Total unique names: ${names.length}`);
  console.log(`Total languages: ${syncMeta.languages.length}`);
  console.log(`Languages: ${syncMeta.languages.length ? syncMeta.languages.join(', ') : 'none'}`);
  console.log('\nIndex key counts:');
  for (const [indexName, index] of Object.entries(indexes)) {
    console.log(`- ${indexName}: ${Object.keys(index).length}`);
  }
  console.log('\nCache file sizes:');
  for (const [fileName, size] of fileSizes) {
    console.log(`- ${fileName}: ${size}`);
  }
  if (syncMeta.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of syncMeta.warnings) console.log(`- ${warning}`);
  }
  if (syncMeta.errors.length) {
    console.log('\nErrors:');
    for (const error of syncMeta.errors) console.log(`- ${error}`);
  }
}

async function findMissingFiles(): Promise<string[]> {
  const results = await Promise.all(
    fileNames.map(async (fileName) => {
      try {
        await fs.access(path.join(cacheDir, fileName));
        return null;
      } catch {
        return fileName;
      }
    })
  );
  return results.filter((fileName): fileName is string => Boolean(fileName));
}

async function readJson<T>(fileName: string): Promise<T> {
  const raw = await fs.readFile(path.join(cacheDir, fileName), 'utf8');
  return JSON.parse(raw) as T;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((error) => {
  console.error('Failed to read Pokemon metadata cache stats.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
