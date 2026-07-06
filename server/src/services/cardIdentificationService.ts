import { TcgdexAdapter } from '../adapters/tcgdexAdapter.js';
import { findPokemonFallbackCard, type PokemonFallbackCard } from '../data/pokemonFallbackCards.js';
import type { ApiSearchDebugEntry, CardCandidate, ExtractedCardDetails, SupportedGame } from '../types/cards.js';
import { normalizeForCompare, similarityScore } from '../utils/fuzzy.js';
import { normalizeKnownPokemonName, normalizePokemonCardNumberForApi, pokemonCardNumbersMatch } from '../utils/pokemonText.js';
import {
  findCandidateCardsFromClues,
  normalizePokemonCacheText,
  type PokemonCachedCard
} from './pokemonMetadataCacheService.js';

export type CardIdentificationResult = {
  topMatch?: CardCandidate;
  alternatives: CardCandidate[];
  allCandidates: CardCandidate[];
  queriesUsed: string[];
  apiCalls: ApiSearchDebugEntry[];
  normalizedName?: string;
  providerUsed?: string;
  confidence?: number;
};

type IdentificationLogger = (message: string) => void;

export class CardIdentificationService {
  constructor(private readonly tcgdexAdapter = new TcgdexAdapter()) {}

  async identify(
    extracted: ExtractedCardDetails,
    selectedGame?: string,
    selectedLanguage?: string,
    log?: IdentificationLogger
  ): Promise<CardIdentificationResult> {
    const game = normalizeGame(selectedGame);
    if (game !== 'pokemon') {
      return { alternatives: [], allCandidates: [], queriesUsed: [], apiCalls: [], normalizedName: extracted.name };
    }

    const normalizedExtracted = normalizePokemonExtraction(extracted);
    log?.(`OCR raw name: ${extracted.name ?? 'n/a'}`);
    log?.(`normalized name: ${normalizedExtracted.name ?? 'n/a'}`);
    log?.(`extracted card number: ${normalizedExtracted.cardNumber ?? 'n/a'}`);
    log?.(`parsed localId: ${normalizedExtracted.localId ?? 'n/a'}`);
    log?.(`parsed printedNumber: ${normalizedExtracted.printedNumber ?? 'n/a'}`);
    log?.(`parsed collectorNumber: ${normalizedExtracted.collectorNumber ?? 'n/a'}`);
    log?.(`parsed set code/name: ${normalizedExtracted.setCode ?? 'n/a'} / ${normalizedExtracted.setName ?? 'n/a'}`);
    log?.(`parsed HP: ${normalizedExtracted.hp ?? 'n/a'}`);

    const queriesUsed: string[] = [];
    const apiCalls: ApiSearchDebugEntry[] = [];
    const candidates: CardCandidate[] = [];

    const localCacheCandidates = await this.searchLocalCache(normalizedExtracted, selectedLanguage, queriesUsed, log);
    candidates.push(...localCacheCandidates);

    const locallyRanked = localCacheCandidates
      .map((candidate) => {
        const ranking = rankPokemonCandidate(candidate, normalizedExtracted);
        return { ...candidate, confidence: ranking.confidence, confidenceReasons: ranking.reasons };
      })
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const bestLocalConfidence = locallyRanked[0]?.confidence ?? 0;
    log?.(`selected local match: ${locallyRanked[0] ? `${locallyRanked[0].name} ${locallyRanked[0].cardNumber ?? ''} ${locallyRanked[0].setName ?? ''}`.trim() : 'n/a'}`);

    const fallbackCard = bestLocalConfidence < 0.85 ? findPokemonFallbackCard(normalizedExtracted) : undefined;
    if (fallbackCard) {
      const fallbackCandidate = toFallbackCandidate(fallbackCard);
      candidates.push(fallbackCandidate);
      queriesUsed.push(`local-fallback:${fallbackCard.normalizedName}:${fallbackCard.cardNumber}:${fallbackCard.normalizedSetCode}`);
      log?.('identification local cache/database result found');
    }

    const shouldUseTcgdexFallback = bestLocalConfidence < 0.75;
    if (shouldUseTcgdexFallback) {
      log?.(`TCGdex fallback used because local cache confidence was ${bestLocalConfidence}`);
      const tcgdexCandidates = await this.searchTcgdex(normalizedExtracted, selectedLanguage, queriesUsed, apiCalls, log);
      candidates.push(...tcgdexCandidates);
    } else {
      log?.(`TCGdex fallback skipped because local cache confidence was ${bestLocalConfidence}`);
    }

    const ranked = dedupeCandidates(candidates)
      .map((candidate) => {
        const ranking = rankPokemonCandidate(candidate, normalizedExtracted);
        return { ...candidate, confidence: ranking.confidence, confidenceReasons: ranking.reasons };
      })
      .filter((candidate) => (candidate.confidence ?? 0) > 0.05)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 6);

    const topMatch = ranked[0];
    log?.(`identification provider used: ${topMatch?.source ?? 'ocr_fallback'}`);
    log?.(`identification confidence: ${topMatch?.confidence ?? 0}`);
    if (!topMatch) log?.('no local cache, fallback, or TCGdex match found');

    return {
      topMatch,
      alternatives: ranked.slice(1, 6),
      allCandidates: ranked,
      queriesUsed,
      apiCalls,
      normalizedName: normalizedExtracted.name,
      providerUsed: topMatch?.source,
      confidence: topMatch?.confidence
    };
  }

  private async searchLocalCache(
    extracted: ExtractedCardDetails,
    selectedLanguage: string | undefined,
    queriesUsed: string[],
    log?: IdentificationLogger
  ): Promise<CardCandidate[]> {
    try {
      const normalizedName = normalizeCardName(extracted.name);
      const cachedCards = await findCandidateCardsFromClues({
        name: extracted.name,
        normalizedName,
        cardNumber: extracted.localId ?? extracted.collectorNumber ?? extracted.cardNumber,
        printedNumber: extracted.printedNumber ?? extracted.cardNumber,
        setCode: extracted.setCode,
        setName: extracted.setName,
        hp: extracted.hp,
        language: selectedLanguage ?? extracted.language,
        rarity: extracted.rarity
      });

      if (extracted.name) queriesUsed.push(`local-cache:name:${extracted.name}`);
      if (extracted.cardNumber) queriesUsed.push(`local-cache:number:${extracted.cardNumber}`);
      if (extracted.printedNumber) queriesUsed.push(`local-cache:printed-number:${extracted.printedNumber}`);
      if (extracted.localId) queriesUsed.push(`local-cache:local-id:${extracted.localId}`);
      if (extracted.setCode) queriesUsed.push(`local-cache:set:${extracted.setCode}`);
      if (extracted.setName) queriesUsed.push(`local-cache:set-name:${extracted.setName}`);
      if (extracted.hp) queriesUsed.push(`local-cache:hp:${extracted.hp}`);

      log?.(`local cache candidates found: ${cachedCards.length}`);
      const candidates = cachedCards.map((card) => toLocalCacheCandidate(card));
      const preview = candidates.slice(0, 3).map((candidate) => `${candidate.name} ${candidate.cardNumber ?? ''} ${candidate.setName ?? ''}`.trim());
      log?.(`local cache raw candidate preview: ${preview.join(' | ') || 'n/a'}`);
      return candidates;
    } catch (error) {
      log?.(`local cache search failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return [];
    }
  }

  private async searchTcgdex(
    extracted: ExtractedCardDetails,
    selectedLanguage: string | undefined,
    queriesUsed: string[],
    apiCalls: ApiSearchDebugEntry[],
    log?: IdentificationLogger
  ): Promise<CardCandidate[]> {
    const results: CardCandidate[] = [];
    const language = selectedLanguage ?? extracted.language ?? 'English';
    const cardNumberForApi = normalizePokemonCardNumberForApi(extracted.cardNumber);

    if (extracted.cardNumber && extracted.setCode) {
      queriesUsed.push(`tcgdex:number:${cardNumberForApi ?? extracted.cardNumber}:${extracted.setCode}`);
      const byNumber = await this.tcgdexAdapter.searchByNumber(extracted.cardNumber, extracted.setCode, language, apiCalls);
      log?.(`TCGdex number search returned ${byNumber.length} result(s)`);
      results.push(...byNumber);
    }

    if (extracted.name) {
      queriesUsed.push(`tcgdex:name:${extracted.name}`);
      try {
        const byName = await this.tcgdexAdapter.searchByName(extracted.name, language, apiCalls);
        log?.(`TCGdex name search returned ${byName.length} result(s)`);
        results.push(...byName);
      } catch (error) {
        log?.(`TCGdex name search failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    return results;
  }
}

function normalizePokemonExtraction(extracted: ExtractedCardDetails): ExtractedCardDetails {
  const name = normalizeKnownPokemonName(extracted.name) ?? cleanSearchName(extracted.name);
  const cardNumber = extracted.printedNumber ?? extracted.collectorNumber ?? extracted.cardNumber ?? extracted.localId ?? undefined;
  const localId = extracted.localId ?? splitPokemonNumber(cardNumber).localId;
  const printedNumber = extracted.printedNumber ?? (splitPokemonNumber(cardNumber).total ? cardNumber : undefined);
  const setCode = extracted.setCode ?? inferSetFromNumber(cardNumber);
  return {
    ...extracted,
    name,
    cardNumber,
    localId,
    printedNumber,
    setCode
  };
}

function cleanSearchName(value?: string): string | undefined {
  const cleaned = String(value ?? '')
    .replace(/\bBASIC\b/gi, '')
    .replace(/\bSTAGE\s?\d\b/gi, '')
    .replace(/\bHP\s?\d+\b/gi, '')
    .replace(/^[^A-Za-z]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const letters = cleaned.match(/[A-Za-z]/g)?.length ?? 0;
  return letters >= 3 ? cleaned : undefined;
}

function inferSetFromNumber(cardNumber?: string): string | undefined {
  if (/\/102\b/.test(cardNumber ?? '')) return 'Base Set';
  return undefined;
}

function toFallbackCandidate(card: PokemonFallbackCard): CardCandidate {
  return {
    id: `local-fallback-${card.normalizedName}-${card.cardNumber}-${card.normalizedSetCode}`,
    source: 'local_fallback_database',
    game: card.game,
    name: card.name,
    setName: card.setName,
    setCode: card.setCode,
    cardNumber: card.cardNumber,
    rarity: card.rarity,
    hp: card.hp,
    prices: card.estimatedValue,
    confidence: 0.88,
    confidenceReasons: ['local fallback database matched name, card number, and set']
  };
}

function toLocalCacheCandidate(card: PokemonCachedCard): CardCandidate {
  return {
    id: card.id,
    source: 'local-cache',
    game: 'pokemon',
    name: card.name,
    setName: card.setName ?? undefined,
    setCode: card.setCode ?? card.setId ?? undefined,
    cardNumber: card.printedNumber ?? card.localId ?? undefined,
    rarity: card.rarity ?? undefined,
    language: card.language,
    hp: card.hp ?? undefined,
    imageUrl: card.imageUrl ?? undefined,
    releaseDate: card.releaseDate ?? undefined
  };
}

function rankPokemonCandidate(candidate: CardCandidate, extracted: ExtractedCardDetails): { confidence: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const extractedName = normalizeCardName(extracted.name);
  const candidateName = normalizeCardName(candidate.name);

  if (candidate.source === 'local_fallback_database') {
    score += 20;
    reasons.push('local cache/database candidate +20');
  }
  if (candidate.source === 'local-cache') {
    score += 15;
    reasons.push('local Pokemon metadata cache candidate +15');
  }

  if (extractedName && candidateName) {
    if (candidateName === extractedName) {
      score += 45;
      reasons.push('exact normalized name match +45');
    } else if (candidateName.includes(extractedName) || extractedName.includes(candidateName)) {
      score += 35;
      reasons.push('name contains OCR-normalized name +35');
    } else {
      const similarity = similarityScore(extracted.name, candidate.name);
      const boost = Math.round(similarity * 25);
      score += boost;
      reasons.push(`name similarity ${Math.round(similarity * 100)}% +${boost}`);
    }
  }

  const extractedNumber = extracted.printedNumber ?? extracted.cardNumber;
  if (extractedNumber && candidate.cardNumber) {
    const numberMatch = getPokemonNumberMatch(extractedNumber, candidate.cardNumber);
    if (numberMatch === 'exact') {
      score += 60;
      reasons.push('printed collector/card number matched +60');
    } else if (numberMatch === 'local-id') {
      score += 45;
      reasons.push('collector/card local number matched +45');
    } else {
      score -= 100;
      reasons.push('collector/card number conflict -100');
    }
  }

  if (isPokemonSetMatch(extracted.setCode, candidate) || isPokemonSetMatch(extracted.setName, candidate)) {
    score += 35;
    reasons.push('set matched +35');
  }

  if (extracted.hp && candidate.hp && String(extracted.hp) === String(candidate.hp)) {
    score += 10;
    reasons.push('HP matched +10');
  }

  if (extracted.language) {
    score += 5;
    reasons.push('language selected +5');
  }

  if (extracted.rarity && candidate.rarity && normalizeCardName(extracted.rarity) === normalizeCardName(candidate.rarity)) {
    score += 5;
    reasons.push('rarity matched +5');
  }

  let confidence = Math.max(0, Math.min(0.99, score / 165));
  const hasUsableNumberMatch = extractedNumber && candidate.cardNumber && getPokemonNumberMatch(extractedNumber, candidate.cardNumber) !== 'conflict';
  const hasSetMatch = isPokemonSetMatch(extracted.setCode, candidate) || isPokemonSetMatch(extracted.setName, candidate);
  if (hasUsableNumberMatch && hasSetMatch) {
    confidence = Math.max(confidence, 0.88);
    reasons.push('number and set match boost to high confidence');
  }
  if (candidate.source === 'local_fallback_database' && confidence >= 0.8) {
    confidence = Math.max(confidence, 0.85);
    reasons.push('local fallback accepted as high-confidence fallback');
  }

  return { confidence: Math.round(confidence * 100) / 100, reasons };
}

function isPokemonSetMatch(setCode: string | undefined, candidate: CardCandidate): boolean {
  const expected = normalizeSetCode(setCode);
  const candidateSetCode = normalizeSetCode(candidate.setCode);
  const candidateSetName = normalizeCardName(candidate.setName);
  if (expected === 'svp') return candidateSetCode === 'svp' || candidateSetName.includes('svp') || candidateSetName.includes('scarlet violet promo');
  if (expected === 'base1') return candidateSetCode === 'base1' || candidateSetName === 'base set';
  return Boolean(expected && (candidateSetCode === expected || candidateSetName.replace(/\s+/g, '') === expected));
}

function normalizeSetCode(value?: string): string {
  const compact = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact.startsWith('svpen') || compact === 'svp') return 'svp';
  if (compact === 'baseset' || compact === 'base1') return 'base1';
  if (compact.startsWith('swsh')) return 'swsh';
  return compact;
}

function normalizeCardName(name?: string): string {
  return normalizePokemonCacheText(normalizeForCompare(name)).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function getPokemonNumberMatch(left?: string, right?: string): 'exact' | 'local-id' | 'conflict' {
  const leftClean = normalizePokemonNumber(left);
  const rightClean = normalizePokemonNumber(right);
  if (!leftClean || !rightClean) return 'conflict';
  if (leftClean === rightClean) return 'exact';

  const leftParts = splitPokemonNumber(leftClean);
  const rightParts = splitPokemonNumber(rightClean);
  if (leftParts.localId && rightParts.localId && leftParts.localId === rightParts.localId) {
    if (leftParts.total && rightParts.total && leftParts.total !== rightParts.total) return 'conflict';
    return 'local-id';
  }

  return pokemonCardNumbersMatch(leftClean, rightClean) ? 'local-id' : 'conflict';
}

function normalizePokemonNumber(value?: string): string | undefined {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9/]+/g, '');
  return cleaned || undefined;
}

function splitPokemonNumber(value?: string): { localId?: string; total?: string } {
  const normalized = normalizePokemonNumber(value);
  if (!normalized) return {};
  const [localId, total] = normalized.split('/');
  return {
    localId: localId?.replace(/^0+(?=\d)/, ''),
    total: total?.replace(/^0+(?=\d)/, '')
  };
}

function normalizeGame(value?: string): SupportedGame {
  const lowered = value?.toLowerCase() ?? '';
  if (lowered.includes('pokemon')) return 'pokemon';
  if (lowered.includes('magic')) return 'magic';
  if (lowered.includes('yug')) return 'yugioh';
  if (lowered.includes('lorc')) return 'lorcana';
  if (lowered.includes('one')) return 'onepiece';
  return 'generic';
}

function dedupeCandidates(candidates: CardCandidate[]): CardCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
