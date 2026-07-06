import fs from 'node:fs/promises';
import path from 'node:path';

export type PokemonCachedCard = {
  id: string;
  provider: 'tcgdex';
  name: string;
  normalizedName: string;
  localId: string | null;
  printedNumber: string | null;
  collectorNumber: string | null;
  setId: string | null;
  setName: string | null;
  setCode: string | null;
  series: string | null;
  rarity: string | null;
  language: string;
  hp: string | null;
  types: string[];
  imageUrl: string | null;
  releaseDate: string | null;
  searchText: string;
};

export type PokemonCachedSet = {
  id: string;
  provider: 'tcgdex';
  name: string;
  normalizedName: string;
  setCode: string | null;
  series: string | null;
  language: string;
  releaseDate: string | null;
  cardCount: {
    official: number | null;
    total: number | null;
  };
};

export type PokemonCacheIndexes = Record<
  'byName' | 'byNormalizedName' | 'byNumber' | 'byPrintedNumber' | 'bySet' | 'bySetCode' | 'byLanguage' | 'byHp',
  Record<string, string[]>
>;

export type PokemonCacheSyncMeta = {
  syncedAt: string | null;
  provider: 'tcgdex';
  source?: string;
  totalCards: number;
  totalSets: number;
  totalNames: number;
  languages: string[];
  warnings: string[];
  errors: string[];
};

export type PokemonCacheStats = PokemonCacheSyncMeta & {
  indexCounts: Record<keyof PokemonCacheIndexes, number>;
  cacheDir: string;
};

export type PokemonMetadataCache = {
  cards: PokemonCachedCard[];
  sets: PokemonCachedSet[];
  names: string[];
  indexes: PokemonCacheIndexes;
  syncMeta: PokemonCacheSyncMeta;
};

export type PokemonCacheLookupClues = {
  name?: string | null;
  normalizedName?: string | null;
  cardNumber?: string | null;
  printedNumber?: string | null;
  setCode?: string | null;
  setName?: string | null;
  hp?: string | null;
  language?: string | null;
  rarity?: string | null;
};

const cacheDir = path.resolve(process.cwd(), 'server/data/pokemon');
let cachePromise: Promise<PokemonMetadataCache> | null = null;

export async function loadPokemonMetadataCache(): Promise<PokemonMetadataCache> {
  cachePromise ??= readPokemonMetadataCache();
  return cachePromise;
}

export async function getStats(): Promise<PokemonCacheStats> {
  return getPokemonMetadataCacheStats();
}

export async function findByNormalizedName(normalizedName: string): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  return cardsForIndexIds(cache, cache.indexes.byNormalizedName[normalizeTextKey(normalizedName)] ?? []);
}

export async function findByNameLike(name: string, limit = 250): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  const normalized = normalizeTextKey(name);
  if (!normalized) return [];

  const exactIds = cache.indexes.byNormalizedName[normalized];
  if (exactIds?.length) return cardsForIndexIds(cache, exactIds).slice(0, limit);

  const compact = compactText(normalized);
  const ids = new Set<string>();
  for (const [key, keyIds] of Object.entries(cache.indexes.byNormalizedName)) {
    const compactKey = compactText(key);
    if (compactKey.includes(compact) || compact.includes(compactKey)) {
      for (const id of keyIds) ids.add(id);
    }
    if (ids.size >= limit) break;
  }

  if (!ids.size) {
    for (const card of cache.cards) {
      if (card.searchText.includes(normalized)) ids.add(card.id);
      if (ids.size >= limit) break;
    }
  }

  return cardsForIndexIds(cache, Array.from(ids)).slice(0, limit);
}

export async function findByNumber(cardNumber: string): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  const keys = uniqueKeys(cardNumber, normalizeCardNumber(cardNumber), localIdFromNumber(cardNumber));
  return cardsForKeys(cache, cache.indexes.byNumber, keys);
}

export async function findByPrintedNumber(printedNumber: string): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  const keys = uniqueKeys(printedNumber, normalizeCardNumber(printedNumber));
  return cardsForKeys(cache, cache.indexes.byPrintedNumber, keys);
}

export async function findBySet(setName: string): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  const keys = uniqueKeys(setName, normalizeTextKey(setName));
  return cardsForKeys(cache, cache.indexes.bySet, keys);
}

export async function findBySetCode(setCode: string): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  const keys = uniqueKeys(setCode, normalizeSetCode(setCode));
  return cardsForKeys(cache, cache.indexes.bySetCode, keys);
}

export async function findByHp(hp: string): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  return cardsForIndexIds(cache, cache.indexes.byHp[String(hp).trim()] ?? []);
}

export async function findCandidateCardsFromClues(clues: PokemonCacheLookupClues, limit = 300): Promise<PokemonCachedCard[]> {
  const groups = await Promise.all([
    clues.normalizedName ? findByNormalizedName(clues.normalizedName) : Promise.resolve([]),
    clues.name ? findByNameLike(clues.name) : Promise.resolve([]),
    clues.cardNumber ? findByNumber(clues.cardNumber) : Promise.resolve([]),
    clues.printedNumber ?? clues.cardNumber ? findByPrintedNumber((clues.printedNumber ?? clues.cardNumber) as string) : Promise.resolve([]),
    clues.setCode ? findBySetCode(clues.setCode) : Promise.resolve([]),
    clues.setName ? findBySet(clues.setName) : Promise.resolve([]),
    clues.hp ? findByHp(clues.hp) : Promise.resolve([])
  ]);

  const byId = new Map<string, PokemonCachedCard>();
  for (const group of groups) {
    for (const card of group) {
      byId.set(card.id, card);
      if (byId.size >= limit) return Array.from(byId.values());
    }
  }
  return Array.from(byId.values());
}

export function normalizePokemonCacheText(value?: string | null): string {
  return normalizeTextKey(value);
}

export function normalizePokemonCacheSetCode(value?: string | null): string | null {
  return normalizeSetCode(value);
}

export function normalizePokemonCacheNumber(value?: string | null): string | null {
  return normalizeCardNumber(value);
}

async function readPokemonMetadataCache(): Promise<PokemonMetadataCache> {
  const [cards, sets, names, indexes, syncMeta] = await Promise.all([
    readJson<PokemonCachedCard[]>('pokemonCards.json'),
    readJson<PokemonCachedSet[]>('pokemonSets.json'),
    readJson<string[]>('pokemonNames.json'),
    readJson<PokemonCacheIndexes>('pokemonIndexes.json'),
    readJson<PokemonCacheSyncMeta>('syncMeta.json')
  ]);

  return { cards, sets, names, indexes, syncMeta };
}

export async function getPokemonMetadataCacheStats(): Promise<PokemonCacheStats> {
  const cache = await loadPokemonMetadataCache();
  const indexCounts = Object.fromEntries(
    Object.entries(cache.indexes).map(([name, index]) => [name, Object.keys(index).length])
  ) as Record<keyof PokemonCacheIndexes, number>;

  return {
    ...cache.syncMeta,
    totalCards: cache.cards.length,
    totalSets: cache.sets.length,
    totalNames: cache.names.length,
    languages: Array.from(new Set(cache.cards.map((card) => card.language))).sort(),
    indexCounts,
    cacheDir
  };
}

export async function findPokemonCachedCardsByIds(ids: string[]): Promise<PokemonCachedCard[]> {
  const cache = await loadPokemonMetadataCache();
  return cardsForIndexIds(cache, ids);
}

export async function findPokemonCachedCardsByNormalizedName(normalizedName: string): Promise<PokemonCachedCard[]> {
  return findByNormalizedName(normalizedName);
}

async function readJson<T>(fileName: string): Promise<T> {
  const raw = await fs.readFile(path.join(cacheDir, fileName), 'utf8');
  return JSON.parse(raw) as T;
}

function cardsForKeys(cache: PokemonMetadataCache, index: Record<string, string[]>, keys: string[]): PokemonCachedCard[] {
  const ids = new Set<string>();
  for (const key of keys) {
    for (const id of index[key] ?? []) ids.add(id);
  }
  return cardsForIndexIds(cache, Array.from(ids));
}

function cardsForIndexIds(cache: PokemonMetadataCache, ids: string[]): PokemonCachedCard[] {
  if (!ids.length) return [];
  const wanted = new Set(ids);
  return cache.cards.filter((card) => wanted.has(card.id));
}

function uniqueKeys(...keys: Array<string | null | undefined>): string[] {
  return Array.from(new Set(keys.map((key) => String(key ?? '').trim()).filter(Boolean)));
}

function normalizeTextKey(value?: string | null): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactText(value?: string | null): string {
  return normalizeTextKey(value).replace(/[^a-z0-9]+/g, '');
}

function normalizeSetCode(value?: string | null): string | null {
  const compact = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!compact) return null;
  if (compact.startsWith('svpen') || compact === 'svp') return 'svp';
  if (compact === 'baseset' || compact === 'base1') return 'base1';
  if (compact.startsWith('swsh')) return 'swsh';
  return compact;
}

function normalizeCardNumber(value?: string | null): string | null {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9/]+/g, '');
  return cleaned || null;
}

function localIdFromNumber(value?: string | null): string | null {
  const normalized = normalizeCardNumber(value);
  if (!normalized) return null;
  const fraction = normalized.match(/^0*([a-z]*\d{1,4})\/[a-z]*\d{1,4}$/i);
  if (fraction) return fraction[1].replace(/^0+(?=\d)/, '');
  return normalized.replace(/^0+(?=\d)/, '');
}
