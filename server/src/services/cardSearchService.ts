import { ApiTcgAdapter } from '../adapters/apiTcgAdapter.js';
import { LorcastAdapter } from '../adapters/lorcastAdapter.js';
import { OptcgAdapter } from '../adapters/optcgAdapter.js';
import { PokemonTcgApiAdapter } from '../adapters/pokemonTcgApiAdapter.js';
import { ScryfallAdapter } from '../adapters/scryfallAdapter.js';
import { TcgdexAdapter } from '../adapters/tcgdexAdapter.js';
import { YgoprodeckAdapter } from '../adapters/ygoprodeckAdapter.js';
import type { ApiSearchDebugEntry, CardApiAdapter, CardCandidate, ExtractedCardDetails, SupportedGame } from '../types/cards.js';
import { normalizeForCompare, similarityScore } from '../utils/fuzzy.js';
import { pokemonCardNumbersMatch } from '../utils/pokemonText.js';

export class CardSearchService {
  private readonly pokemonApiAdapter = new PokemonTcgApiAdapter();
  private readonly tcgdexAdapter = new TcgdexAdapter();

  private readonly adapters: CardApiAdapter[] = [
    this.pokemonApiAdapter,
    this.tcgdexAdapter,
    new ScryfallAdapter(),
    new YgoprodeckAdapter(),
    new LorcastAdapter(),
    new OptcgAdapter(),
    new ApiTcgAdapter('onepiece', 'one-piece')
  ];

  async search(extracted: ExtractedCardDetails, selectedGame?: string, selectedLanguage?: string) {
    const adapters = this.selectAdapters(selectedGame);
    if (adapters.length === 0) {
      return {
        topMatch: undefined,
        alternatives: [],
        allCandidates: [],
        queriesUsed: []
      };
    }
    const candidateMap = new Map<string, CardCandidate>();
    const queriesUsed: string[] = [];
    const apiCalls: ApiSearchDebugEntry[] = [];

    const adapterResults = await Promise.all(
      adapters.map(async (adapter) => ({
        adapter,
        matches: await this.fetchAdapterMatches(adapter, extracted, selectedLanguage, queriesUsed, apiCalls)
      }))
    );

    for (const { matches } of adapterResults) {
      for (const candidate of matches) {
        const ranking = this.rankCandidate(candidate, extracted, selectedGame);
        const scored = {
          ...candidate,
          confidence: ranking.confidence,
          confidenceReasons: ranking.reasons
        };
        const key = `${candidate.source}:${candidate.id}`;
        const existing = candidateMap.get(key);
        if (!existing || (scored.confidence ?? 0) > (existing.confidence ?? 0)) {
          candidateMap.set(key, scored);
        }
      }
    }

    const ranked = Array.from(candidateMap.values())
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 5);

    return {
      topMatch: ranked[0],
      alternatives: ranked.slice(1),
      allCandidates: ranked,
      queriesUsed,
      apiCalls
    };
  }

  private async fetchAdapterMatches(
    adapter: CardApiAdapter,
    extracted: ExtractedCardDetails,
    language: string | undefined,
    queriesUsed: string[],
    apiCalls: ApiSearchDebugEntry[]
  ) {
    const results: CardCandidate[] = [];

    if (adapter.source === 'pokemon-tcg-api') {
      await this.fetchPokemonMatchesInPreferredOrder(extracted, queriesUsed, apiCalls, results);
      return dedupeCandidates(results);
    }

    if (extracted.cardNumber) {
      queriesUsed.push(`${adapter.source}:number:${extracted.cardNumber}:${extracted.setCode ?? ''}`);
      try {
        const byNumber = await adapter.searchByNumber(extracted.cardNumber, extracted.setCode, language, apiCalls);
        results.push(...byNumber);
      } catch (error) {
        apiCalls.push({
          source: adapter.source,
          searchType: 'number',
          query: `${extracted.cardNumber}${extracted.setCode ? ` ${extracted.setCode}` : ''}`,
          endpoint: 'adapter.searchByNumber',
          error: error instanceof Error ? error.message : 'Unknown adapter error'
        });
      }
    }

    if (extracted.name) {
      queriesUsed.push(`${adapter.source}:name:${extracted.name}`);
      try {
        const byName = await adapter.searchByName(extracted.name, language, apiCalls);
        results.push(...byName);
      } catch (error) {
        apiCalls.push({
          source: adapter.source,
          searchType: 'name',
          query: extracted.name,
          endpoint: 'adapter.searchByName',
          error: error instanceof Error ? error.message : 'Unknown adapter error'
        });
      }
    }

    return dedupeCandidates(results);
  }

  private async fetchPokemonMatchesInPreferredOrder(
    extracted: ExtractedCardDetails,
    queriesUsed: string[],
    apiCalls: ApiSearchDebugEntry[],
    results: CardCandidate[]
  ): Promise<void> {
    if (extracted.name) {
      queriesUsed.push(`${this.pokemonApiAdapter.source}:name:${extracted.name}`);
      try {
        const byName = await this.pokemonApiAdapter.searchByName(extracted.name, undefined, apiCalls);
        results.push(...byName);
      } catch (error) {
        apiCalls.push({
          source: this.pokemonApiAdapter.source,
          searchType: 'name',
          query: extracted.name,
          endpoint: 'adapter.searchByName',
          error: error instanceof Error ? error.message : 'Unknown adapter error'
        });
      }
    }

    if (extracted.cardNumber && extracted.name) {
      queriesUsed.push(`${this.pokemonApiAdapter.source}:composite:${extracted.cardNumber}:${extracted.name}:${extracted.setCode ?? ''}`);
      try {
        const byComposite = await this.pokemonApiAdapter.searchByCompositeHints(
          {
            name: extracted.name,
            cardNumber: extracted.cardNumber,
            setCode: extracted.setCode
          },
          apiCalls
        );
        results.push(...byComposite);
      } catch (error) {
        apiCalls.push({
          source: this.pokemonApiAdapter.source,
          searchType: 'number',
          query: `${extracted.cardNumber} ${extracted.name}`,
          endpoint: 'adapter.searchByCompositeHints',
          error: error instanceof Error ? error.message : 'Unknown adapter error'
        });
      }
    }

    if (extracted.name && extracted.setCode) {
      queriesUsed.push(`${this.pokemonApiAdapter.source}:name-set:${extracted.name}:${extracted.setCode}`);
      try {
        const byNameAndSet = await this.pokemonApiAdapter.searchByNameAndSet(extracted.name, extracted.setCode, apiCalls);
        results.push(...byNameAndSet);
      } catch (error) {
        apiCalls.push({
          source: this.pokemonApiAdapter.source,
          searchType: 'name',
          query: `${extracted.name} ${extracted.setCode}`,
          endpoint: 'adapter.searchByNameAndSet',
          error: error instanceof Error ? error.message : 'Unknown adapter error'
        });
      }
    }

    if (extracted.cardNumber && extracted.setCode) {
      queriesUsed.push(`${this.pokemonApiAdapter.source}:number-set:${extracted.cardNumber}:${extracted.setCode}`);
      try {
        const byNumberAndSet = await this.pokemonApiAdapter.searchByNumber(extracted.cardNumber, extracted.setCode, undefined, apiCalls);
        results.push(...byNumberAndSet);
      } catch (error) {
        apiCalls.push({
          source: this.pokemonApiAdapter.source,
          searchType: 'number',
          query: `${extracted.cardNumber} ${extracted.setCode}`,
          endpoint: 'adapter.searchByNumber',
          error: error instanceof Error ? error.message : 'Unknown adapter error'
        });
      }
    }

    if (results.length === 0 && !extracted.name && !extracted.cardNumber && !extracted.setCode && extracted.attackNameHint) {
      queriesUsed.push(`${this.pokemonApiAdapter.source}:attack:${extracted.attackNameHint}`);
      try {
        const byAttack = await this.pokemonApiAdapter.searchByAttackName(extracted.attackNameHint, apiCalls);
        results.push(...byAttack);
      } catch (error) {
        apiCalls.push({
          source: this.pokemonApiAdapter.source,
          searchType: 'attack',
          query: extracted.attackNameHint,
          endpoint: 'adapter.searchByAttackName',
          error: error instanceof Error ? error.message : 'Unknown adapter error'
        });
      }
    }
  }

  private selectAdapters(selectedGame?: string): CardApiAdapter[] {
    if (!selectedGame) return [];
    const normalized = normalizeGame(selectedGame);
    return this.adapters.filter((adapter) => adapter.game === normalized);
  }

  private rankCandidate(candidate: CardCandidate, extracted: ExtractedCardDetails, selectedGame?: string): { confidence: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];
    const normalizedExtractedName = normalizeCardName(extracted.name);
    const normalizedCandidateName = normalizeCardName(candidate.name);

    if (selectedGame && candidate.game === normalizeGame(selectedGame)) {
      reasons.push('selected game matches candidate game');
    }

    if (normalizedExtractedName && normalizedCandidateName) {
      if (normalizedCandidateName === normalizedExtractedName) {
        score += 60;
        reasons.push('exact normalized name match +60');
      } else if (normalizedCandidateName.includes(normalizedExtractedName)) {
        score += 45;
        reasons.push('official card name contains OCR name +45');
      } else {
        const nameSimilarity = similarityScore(extracted.name, candidate.name);
        const boost = Math.round(nameSimilarity * 35);
        score += boost;
        reasons.push(`name similarity ${Math.round(nameSimilarity * 100)}% +${boost}`);
      }
    }

    if (extracted.cardNumber && candidate.cardNumber) {
      if (pokemonCardNumbersMatch(extracted.cardNumber, candidate.cardNumber)) {
        score += 80;
        reasons.push('collector/card number exact match +80');
      } else {
        score -= 100;
        reasons.push('collector/card number conflicts -100');
      }
    }
    if (extracted.setCode && isPokemonSetMatch(extracted.setCode, candidate)) {
      score += 40;
      reasons.push('set/promo series matches +40');
    }
    if (extracted.language) {
      score += 10;
      reasons.push('selected language available +10');
    }
    if (extracted.hp && candidate.hp) {
      if (String(extracted.hp) === String(candidate.hp)) {
        score += 10;
        reasons.push('Pokemon HP exact match +10');
      } else {
        reasons.push('candidate has HP but it is not exact');
      }
    }
    if (extracted.year && candidate.releaseDate?.startsWith(extracted.year)) {
      score += 10;
      reasons.push('release year matches OCR copyright year +10');
    }

    const raritySimilarity = similarityScore(extracted.rarity, candidate.rarity);
    if (raritySimilarity > 0) {
      const boost = raritySimilarity * 5;
      score += boost;
      reasons.push(`rarity similarity ${Math.round(raritySimilarity * 100)}% +${boost.toFixed(0)}`);
    }
    if (!extracted.name && extracted.attackNameHint && candidate.source === 'pokemon-tcg-api') {
      score += 15;
      reasons.push('text match from Pokemon attack clue +15');
    }

    let confidence = Math.min(0.99, score / 170);
    if (extracted.name && !extracted.cardNumber && extracted.setCode) confidence = Math.min(confidence, 0.75);
    if (extracted.name && !extracted.cardNumber && !extracted.setCode) confidence = Math.min(confidence, 0.65);
    if (extracted.cardNumber && candidate.cardNumber && pokemonCardNumbersMatch(extracted.cardNumber, candidate.cardNumber) && extracted.setCode && isPokemonSetMatch(extracted.setCode, candidate)) {
      confidence = Math.max(confidence, 0.88);
      reasons.push('exact card number and set match boost to at least 0.88');
    }
    return {
      confidence: Math.round(confidence * 100) / 100,
      reasons
    };
  }
}

function normalizeCardName(name?: string): string {
  return normalizeForCompare(name).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPokemonSetMatch(setCode: string, candidate: CardCandidate): boolean {
  const expected = setCode.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const candidateSet = `${candidate.setCode ?? ''} ${candidate.setName ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (expected.startsWith('svpen') || expected === 'svp') return candidateSet.includes('svp') || candidateSet.includes('scarletvioletpromo');
  if (expected.startsWith('swsh')) return candidateSet.includes('swsh') || candidateSet.includes('swordshieldpromo');
  if (expected === 'baseset' || expected === 'base1') return candidateSet.includes('base1') || candidateSet.includes('baseset');
  return candidateSet.includes(expected);
}

function normalizeGame(value: string): SupportedGame {
  const lowered = value.toLowerCase();
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
