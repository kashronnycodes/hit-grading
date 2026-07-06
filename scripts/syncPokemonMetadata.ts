import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type PokemonCachedCard = {
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

type PokemonCachedSet = {
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

type PokemonIndexes = Record<
  'byName' | 'byNormalizedName' | 'byNumber' | 'byPrintedNumber' | 'bySet' | 'bySetCode' | 'byLanguage' | 'byHp',
  Record<string, string[]>
>;

type TcgdxSetSummary = {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
};

type TcgdexSet = TcgdxSetSummary & {
  series?: string;
  releaseDate?: string;
  cardCount?: {
    official?: number;
    total?: number;
  };
  cards?: TcgdexCardSummary[];
};

type TcgdexCardSummary = {
  id: string;
  localId?: string;
  name: string;
  image?: string;
};

type TcgdexCard = TcgdexCardSummary & {
  rarity?: string;
  hp?: string | number;
  types?: string[];
  set?: {
    id?: string;
    name?: string;
    series?: string;
    releaseDate?: string;
    cardCount?: {
      official?: number;
      total?: number;
    };
  };
};

type SyncPayload = {
  cards: PokemonCachedCard[];
  sets: PokemonCachedSet[];
  languages: string[];
};

const execFileAsync = promisify(execFile);

const provider = 'tcgdex' as const;
const syncSource = parseSyncSource(process.env.POKEMON_SYNC_SOURCE ?? 'tcgdex-api');
const baseUrl = trimTrailingSlash(process.env.TCGDEX_BASE_URL ?? 'https://api.tcgdex.net/v2');
const languages = parseLanguages(process.env.POKEMON_SYNC_LANGUAGES ?? 'en');
const cacheDir = path.resolve(process.cwd(), 'server/data/pokemon');
const localSourceDir = path.resolve(process.cwd(), process.env.POKEMON_SYNC_LOCAL_SOURCE_DIR ?? 'server/data/pokemon-source');
const timeoutMs = parsePositiveInt(process.env.POKEMON_SYNC_TIMEOUT_MS, 30000);
const retryCount = parsePositiveInt(process.env.POKEMON_SYNC_RETRIES, 3);
const retryDelayMs = parsePositiveInt(process.env.POKEMON_SYNC_RETRY_DELAY_MS, 1500);
const forceIpv4 = parseBoolean(process.env.POKEMON_SYNC_FORCE_IPV4, false);
const hydrateCards = parseBoolean(process.env.POKEMON_SYNC_HYDRATE_CARDS, false);
const httpClient = parseHttpClient(process.env.POKEMON_SYNC_HTTP_CLIENT ?? 'auto');
let effectiveSyncSource = syncSource;
const warnings: string[] = [];
const errors: string[] = [];
let usePowerShellForRemainingRequests = httpClient === 'powershell';

if (forceIpv4) {
  dns.setDefaultResultOrder('ipv4first');
}

async function main() {
  console.log('Pokemon metadata sync');
  console.log('---------------------');
  console.log(`Source: ${syncSource}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Languages: ${languages.join(', ')}`);
  console.log(`Timeout: ${timeoutMs}ms`);
  console.log(`Retries: ${retryCount}`);
  console.log(`Retry delay: ${retryDelayMs}ms`);
  console.log(`Force IPv4: ${forceIpv4 ? 'yes' : 'no'}`);
  console.log(`HTTP client: ${httpClient}`);
  console.log(`Hydrate individual cards: ${hydrateCards ? 'yes' : 'no'}`);

  const payload = await loadSyncPayload();
  const names = buildNames(payload.cards);
  const indexes = buildIndexes(payload.cards);

  validateSuccessfulSync(payload.cards, payload.sets, names);

  const syncMeta = {
    syncedAt: new Date().toISOString(),
    provider,
    source: effectiveSyncSource,
    totalCards: payload.cards.length,
    totalSets: payload.sets.length,
    totalNames: names.length,
    languages: payload.languages,
    warnings,
    errors
  };

  await fs.mkdir(cacheDir, { recursive: true });
  await Promise.all([
    writeJsonAtomic('pokemonCards.json', payload.cards),
    writeJsonAtomic('pokemonSets.json', payload.sets),
    writeJsonAtomic('pokemonNames.json', names),
    writeJsonAtomic('pokemonIndexes.json', indexes),
    writeJsonAtomic('syncMeta.json', syncMeta)
  ]);

  console.log('\nPokemon metadata sync complete');
  console.log(`Cards: ${payload.cards.length}`);
  console.log(`Sets: ${payload.sets.length}`);
  console.log(`Unique names: ${names.length}`);
  console.log(`Languages: ${payload.languages.join(', ')}`);
  console.log(`Warnings: ${warnings.length}`);
}

async function loadSyncPayload(): Promise<SyncPayload> {
  if (syncSource === 'tcgdex-api') {
    try {
      effectiveSyncSource = 'tcgdex-api';
      return await syncFromTcgdexApi();
    } catch (error) {
      warnings.push(`TCGdex API sync failed; falling back to tcgdex-github. ${formatError(error)}`);
      console.warn(`TCGdex API sync failed; falling back to tcgdex-github. ${formatError(error)}`);
      effectiveSyncSource = 'tcgdex-github';
      return syncFromTcgdexGithub();
    }
  }
  if (syncSource === 'local-json') {
    effectiveSyncSource = 'local-json';
    return syncFromLocalJson();
  }
  effectiveSyncSource = 'tcgdex-github';
  return syncFromTcgdexGithub();
}

async function syncFromTcgdexApi(): Promise<SyncPayload> {
  const cards: PokemonCachedCard[] = [];
  const sets: PokemonCachedSet[] = [];

  for (const language of languages) {
    const languageSets = await fetchJson<TcgdxSetSummary[]>(`/${language}/sets`);
    console.log(`[${language}] Sets found: ${languageSets.length}`);

    for (const [index, setSummary] of languageSets.entries()) {
      const set = await fetchSet(language, setSummary);
      sets.push(normalizeSet(set, language));

      const cardSummaries = set.cards ?? [];
      if (!cardSummaries.length) {
        warnings.push(`[${language}] Set ${set.id} (${set.name}) did not include cards.`);
        continue;
      }

      const cardInputs = hydrateCards
        ? await mapWithConcurrency(cardSummaries, 6, async (cardSummary) => {
            try {
              return await fetchJson<TcgdexCard>(`/${language}/cards/${encodeURIComponent(cardSummary.id)}`);
            } catch (error) {
              warnings.push(
                `[${language}] Failed to hydrate card ${cardSummary.id}; using set summary. ${formatError(error)}`
              );
              return cardSummary;
            }
          })
        : cardSummaries;

      for (const card of cardInputs) {
        cards.push(normalizeCard(card, set, language));
      }

      if ((index + 1) % 25 === 0 || index + 1 === languageSets.length) {
        console.log(`[${language}] Synced ${index + 1}/${languageSets.length} sets, ${cards.length} cards total`);
      }
    }
  }

  return {
    cards,
    sets,
    languages
  };
}

async function syncFromLocalJson(): Promise<SyncPayload> {
  console.log(`Reading local Pokemon metadata source from ${localSourceDir}`);
  const normalizedCardsPath = path.join(localSourceDir, 'pokemonCards.json');
  const normalizedSetsPath = path.join(localSourceDir, 'pokemonSets.json');

  if (await fileExists(normalizedCardsPath) && await fileExists(normalizedSetsPath)) {
    const cards = await readJsonFile<PokemonCachedCard[]>(normalizedCardsPath);
    const sets = await readJsonFile<PokemonCachedSet[]>(normalizedSetsPath);
    return {
      cards,
      sets,
      languages: Array.from(new Set(cards.map((card) => card.language))).sort()
    };
  }

  const cards: PokemonCachedCard[] = [];
  const sets: PokemonCachedSet[] = [];

  for (const language of languages) {
    const languageSets = await readLocalJson<TcgdxSetSummary[]>(language, 'sets.json');
    console.log(`[${language}] Local sets found: ${languageSets.length}`);

    for (const setSummary of languageSets) {
      const set = await readOptionalLocalJson<TcgdexSet>(language, `sets/${setSummary.id}.json`) ?? setSummary;
      sets.push(normalizeSet(set, language));

      const cardSummaries = set.cards ?? [];
      for (const cardSummary of cardSummaries) {
        const card = await readOptionalLocalJson<TcgdexCard>(language, `cards/${cardSummary.id}.json`) ?? cardSummary;
        cards.push(normalizeCard(card, set, language));
      }
    }
  }

  return {
    cards,
    sets,
    languages
  };
}

async function syncFromTcgdexGithub(): Promise<SyncPayload> {
  const tempDir = path.join(localSourceDir, `.tcgdex-github-${Date.now()}-${process.pid}`);
  const zipPath = path.join(tempDir, 'cards-database.zip');
  const extractDir = path.join(tempDir, 'extract');
  const archiveUrl = process.env.TCGDEX_GITHUB_ARCHIVE_URL
    ?? 'https://github.com/tcgdex/cards-database/archive/refs/heads/master.zip';

  try {
    console.log(`Downloading TCGdex GitHub archive from ${archiveUrl}`);
    await fs.mkdir(tempDir, { recursive: true });
    await downloadAndExtractArchive(archiveUrl, zipPath, extractDir);

    const repoRoot = await findExtractedRepoRoot(extractDir);
    const dataDir = path.join(repoRoot, 'data');
    const seriesFiles = (await fs.readdir(dataDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(dataDir, entry.name));

    const cards: PokemonCachedCard[] = [];
    const sets: PokemonCachedSet[] = [];
    const selectedLanguage = languages[0] ?? 'en';

    for (const [seriesIndex, seriesFile] of seriesFiles.entries()) {
      const seriesName = path.basename(seriesFile, '.ts');
      const seriesSource = await fs.readFile(seriesFile, 'utf8');
      const seriesDisplayName = parseLocalizedField(seriesSource, 'name', selectedLanguage) ?? seriesName;
      const seriesDir = path.join(dataDir, seriesName);
      if (!await fileExists(seriesDir)) continue;

      const setFiles = (await fs.readdir(seriesDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => path.join(seriesDir, entry.name));

      for (const setFile of setFiles) {
        const setSource = await fs.readFile(setFile, 'utf8');
        const setId = parseStringProperty(setSource, 'id') ?? normalizeSetCode(path.basename(setFile, '.ts')) ?? path.basename(setFile, '.ts');
        const setName = parseLocalizedField(setSource, 'name', selectedLanguage) ?? path.basename(setFile, '.ts');
        const set: TcgdexSet = {
          id: setId,
          name: setName,
          series: seriesDisplayName,
          releaseDate: parseStringProperty(setSource, 'releaseDate') ?? undefined,
          cardCount: {
            official: parseNumberProperty(setSource, 'official') ?? undefined,
            total: parseNumberProperty(setSource, 'total') ?? undefined
          }
        };
        sets.push(normalizeSet(set, selectedLanguage));

        const cardDir = path.join(seriesDir, path.basename(setFile, '.ts'));
        if (!await fileExists(cardDir)) continue;

        const cardFiles = (await walkFiles(cardDir))
          .filter((file) => file.endsWith('.ts'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        for (const cardFile of cardFiles) {
          const cardSource = await fs.readFile(cardFile, 'utf8');
          const name = parseLocalizedField(cardSource, 'name', selectedLanguage);
          if (!name) continue;
          const localId = path.basename(cardFile, '.ts');
          const card: TcgdexCard = {
            id: `${setId}-${localId}`,
            localId,
            name,
            rarity: parseStringProperty(cardSource, 'rarity') ?? undefined,
            hp: parseNumberProperty(cardSource, 'hp') ?? undefined,
            types: parseStringArrayProperty(cardSource, 'types'),
            set: {
              id: set.id,
              name: set.name,
              series: set.series,
              releaseDate: set.releaseDate,
              cardCount: set.cardCount
            }
          };
          cards.push(normalizeCard(card, set, selectedLanguage));
        }
      }

      if ((seriesIndex + 1) % 5 === 0 || seriesIndex + 1 === seriesFiles.length) {
        console.log(`[github] Parsed ${seriesIndex + 1}/${seriesFiles.length} series, ${sets.length} sets, ${cards.length} cards`);
      }
    }

    return {
      cards,
      sets,
      languages: [selectedLanguage]
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchSet(language: string, setSummary: TcgdxSetSummary): Promise<TcgdexSet> {
  try {
    return await fetchJson<TcgdexSet>(`/${language}/sets/${encodeURIComponent(setSummary.id)}`);
  } catch (error) {
    warnings.push(`[${language}] Failed to fetch set ${setSummary.id}; using summary only. ${formatError(error)}`);
    return setSummary;
  }
}

function normalizeSet(set: TcgdexSet, language: string): PokemonCachedSet {
  return {
    id: set.id,
    provider,
    name: set.name,
    normalizedName: normalizeTextKey(set.name),
    setCode: normalizeSetCode(set.id),
    series: set.series ?? null,
    language,
    releaseDate: set.releaseDate ?? null,
    cardCount: {
      official: numberOrNull(set.cardCount?.official),
      total: numberOrNull(set.cardCount?.total)
    }
  };
}

function normalizeCard(card: TcgdexCard | TcgdexCardSummary, set: TcgdexSet, language: string): PokemonCachedCard {
  const setId = cardHasSet(card) ? card.set?.id ?? set.id : set.id;
  const setName = cardHasSet(card) ? card.set?.name ?? set.name : set.name;
  const series = cardHasSet(card) ? card.set?.series ?? set.series ?? null : set.series ?? null;
  const releaseDate = cardHasSet(card) ? card.set?.releaseDate ?? set.releaseDate ?? null : set.releaseDate ?? null;
  const officialTotal = cardHasSet(card)
    ? numberOrNull(card.set?.cardCount?.official) ?? numberOrNull(set.cardCount?.official)
    : numberOrNull(set.cardCount?.official);
  const localId = card.localId ?? null;
  const printedNumber = localId && officialTotal ? `${localId}/${officialTotal}` : localId;
  const rarity = 'rarity' in card ? card.rarity ?? null : null;
  const hp = 'hp' in card && card.hp !== undefined ? String(card.hp) : null;
  const types = 'types' in card && Array.isArray(card.types) ? card.types.filter(Boolean).map(String) : [];
  const normalizedName = normalizeTextKey(card.name);
  const setCode = normalizeSetCode(setId);
  const searchText = [
    card.name,
    normalizedName,
    localId,
    printedNumber,
    setId,
    setName,
    setCode,
    series,
    rarity,
    hp,
    language,
    ...types
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return {
    id: `${provider}:${language}:${card.id}`,
    provider,
    name: card.name,
    normalizedName,
    localId,
    printedNumber,
    collectorNumber: printedNumber,
    setId: setId ?? null,
    setName: setName ?? null,
    setCode,
    series,
    rarity,
    language,
    hp,
    types,
    imageUrl: card.image ?? null,
    releaseDate,
    searchText
  };
}

function buildNames(cards: PokemonCachedCard[]): string[] {
  return Array.from(new Set(cards.map((card) => card.name).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function buildIndexes(cards: PokemonCachedCard[]): PokemonIndexes {
  const indexes: PokemonIndexes = {
    byName: {},
    byNormalizedName: {},
    byNumber: {},
    byPrintedNumber: {},
    bySet: {},
    bySetCode: {},
    byLanguage: {},
    byHp: {}
  };

  for (const card of cards) {
    addIndex(indexes.byName, card.name, card.id);
    addIndex(indexes.byNormalizedName, card.normalizedName, card.id);
    addIndex(indexes.byNumber, card.localId, card.id);
    addIndex(indexes.byNumber, normalizeNumber(card.localId), card.id);
    addIndex(indexes.byPrintedNumber, card.printedNumber, card.id);
    addIndex(indexes.byPrintedNumber, normalizeNumber(card.printedNumber), card.id);
    addIndex(indexes.bySet, card.setId, card.id);
    addIndex(indexes.bySet, card.setName, card.id);
    addIndex(indexes.bySetCode, card.setCode, card.id);
    addIndex(indexes.byLanguage, card.language, card.id);
    addIndex(indexes.byHp, card.hp, card.id);
  }

  return indexes;
}

function addIndex(index: Record<string, string[]>, key: string | null | undefined, id: string) {
  const normalized = String(key ?? '').trim();
  if (!normalized) return;
  index[normalized] ??= [];
  if (!index[normalized].includes(id)) index[normalized].push(id);
}

async function writeJsonAtomic(fileName: string, data: unknown) {
  const finalPath = path.join(cacheDir, fileName);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, finalPath);
}

async function fetchJson<T>(pathName: string): Promise<T> {
  const url = `${baseUrl}${pathName}`;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await requestJsonWithConfiguredClient<T>(url);
    } catch (error) {
      lastError = error;
      if (attempt === retryCount) break;
      const delay = retryDelayMs * 2 ** attempt;
      console.warn(`Request failed; retrying in ${delay}ms (${attempt + 1}/${retryCount}). ${formatError(error)}`);
      await sleep(delay);
    }
  }

  throw new Error(`TCGdex request failed for ${url}: ${formatProviderError(lastError)}`);
}

async function requestJsonWithConfiguredClient<T>(url: string): Promise<T> {
  if (usePowerShellForRemainingRequests) return requestJsonWithPowerShell<T>(url);
  return requestJsonWithAxios<T>(url);
}

async function requestJsonWithAxios<T>(url: string): Promise<T> {
  const config: AxiosRequestConfig = {
    url,
    method: 'GET',
    timeout: timeoutMs,
    headers: { Accept: 'application/json' },
    responseType: 'json'
  };

  if (forceIpv4) {
    config.httpsAgent = new https.Agent({
      family: 4,
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { ...options, family: 4 }, callback);
      }
    });
  }

  const response = await axios.request<T>(config);
  return response.data;
}

async function requestJsonWithPowerShell<T>(url: string): Promise<T> {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const command = [
    '& {',
    'param([string]$uri, [int]$timeout)',
    "$ProgressPreference = 'SilentlyContinue';",
    '(Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec $timeout).Content',
    '}'
  ].join(' ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command, url, String(timeoutSeconds)],
    { maxBuffer: 1024 * 1024 * 50 }
  );
  return JSON.parse(stdout) as T;
}

async function downloadAndExtractArchive(url: string, zipPath: string, extractDir: string): Promise<void> {
  const timeoutSeconds = Math.max(120, Math.ceil(timeoutMs / 1000));
  const command = [
    '& {',
    'param([string]$uri, [string]$zipPath, [string]$extractDir, [int]$timeout)',
    "$ProgressPreference = 'SilentlyContinue';",
    'Invoke-WebRequest -Uri $uri -OutFile $zipPath -UseBasicParsing -TimeoutSec $timeout;',
    'Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force;',
    '}'
  ].join(' ');
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
      url,
      zipPath,
      extractDir,
      String(timeoutSeconds)
    ],
    { maxBuffer: 1024 * 1024 * 10 }
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readLocalJson<T>(language: string, fileName: string): Promise<T> {
  const candidates = [
    path.join(localSourceDir, language, fileName),
    path.join(localSourceDir, fileName)
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return readJsonFile<T>(candidate);
  }
  throw new Error(
    `Local JSON source file not found: ${candidates.join(' or ')}. ` +
      'Place downloaded metadata in server/data/pokemon-source or set POKEMON_SYNC_LOCAL_SOURCE_DIR.'
  );
}

async function findExtractedRepoRoot(extractDir: string): Promise<string> {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const repoDir = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('cards-database-'));
  if (!repoDir) throw new Error(`Could not find extracted cards-database folder in ${extractDir}`);
  return path.join(extractDir, repoDir.name);
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
    })
  );
  return files.flat();
}

async function readOptionalLocalJson<T>(language: string, fileName: string): Promise<T | null> {
  try {
    return await readLocalJson<T>(language, fileName);
  } catch {
    return null;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateSuccessfulSync(cards: PokemonCachedCard[], sets: PokemonCachedSet[], names: string[]) {
  if (cards.length > 0 && sets.length > 0 && names.length > 0) return;
  throw new Error(
    `Sync produced an empty cache and was not written. cards=${cards.length} sets=${sets.length} names=${names.length}`
  );
}

function parseLanguages(value: string): string[] {
  const parsed = value
    .split(',')
    .map((language) => language.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? Array.from(new Set(parsed)) : ['en'];
}

function parseSyncSource(value: string): 'tcgdex-api' | 'tcgdex-github' | 'local-json' {
  if (value === 'tcgdex-api' || value === 'tcgdex-github' || value === 'local-json') return value;
  throw new Error(`Invalid POKEMON_SYNC_SOURCE "${value}". Use tcgdex-api, tcgdex-github, or local-json.`);
}

function parseHttpClient(value: string): 'auto' | 'node' | 'powershell' {
  if (value === 'auto' || value === 'node' || value === 'powershell') return value;
  throw new Error(`Invalid POKEMON_SYNC_HTTP_CLIENT "${value}". Use auto, node, or powershell.`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function normalizeTextKey(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeSetCode(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized || null;
}

function normalizeNumber(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9/]+/g, '');
  return normalized || null;
}

function parseLocalizedField(source: string, property: string, language: string): string | null {
  const objectMatch = source.match(new RegExp(`${escapeRegExp(property)}\\s*:\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm'));
  const objectBody = objectMatch?.[1];
  if (!objectBody) return null;
  return parseLocalizedValue(objectBody, language) ?? parseLocalizedValue(objectBody, 'en');
}

function parseLocalizedValue(objectBody: string, language: string): string | null {
  const match = objectBody.match(new RegExp(`\\b${escapeRegExp(language)}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, 'm'));
  return match?.[1] ?? null;
}

function parseStringProperty(source: string, property: string): string | null {
  const match = source.match(new RegExp(`\\b${escapeRegExp(property)}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, 'm'));
  return match?.[1] ?? null;
}

function parseNumberProperty(source: string, property: string): number | null {
  const match = source.match(new RegExp(`\\b${escapeRegExp(property)}\\s*:\\s*(\\d+)`, 'm'));
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseStringArrayProperty(source: string, property: string): string[] {
  const match = source.match(new RegExp(`\\b${escapeRegExp(property)}\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  if (!match) return [];
  return Array.from(match[1].matchAll(/["'`]([^"'`]+)["'`]/g)).map((item) => item[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cardHasSet(card: TcgdexCard | TcgdexCardSummary): card is TcgdexCard {
  return 'set' in card;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatProviderError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const code = error.code;
    const pieces = [
      status ? `status ${status}` : null,
      code ? `code ${code}` : null,
      error.message
    ].filter(Boolean);
    return pieces.join(' - ');
  }
  return formatError(error);
}

main().catch((error) => {
  errors.push(formatError(error));
  console.error('Pokemon metadata sync failed. Existing cache files were not replaced.');
  console.error(formatError(error));
  process.exitCode = 1;
});
