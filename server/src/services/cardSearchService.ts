import { ApiTcgAdapter } from '../adapters/apiTcgAdapter.js';
import { LorcastAdapter } from '../adapters/lorcastAdapter.js';
import { OptcgAdapter } from '../adapters/optcgAdapter.js';
import { PokemonTcgApiAdapter } from '../adapters/pokemonTcgApiAdapter.js';
import { ScryfallAdapter } from '../adapters/scryfallAdapter.js';
import { TcgdexAdapter } from '../adapters/tcgdexAdapter.js';
import { YgoprodeckAdapter } from '../adapters/ygoprodeckAdapter.js';
import type { ApiSearchDebugEntry, CardApiAdapter, CardCandidate, ExtractedCardDetails, SupportedGame } from '../types/cards.js';
import { normalizeForCompare, similarityScore } from '../utils/fuzzy.js';

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

    if (results.length === 0 && extracted.name && extracted.attackNameHint) {
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
    let score = 0.12;
    const reasons: string[] = ['base candidate score +0.12'];
    const normalizedExtractedName = normalizeForCompare(extracted.name);
    const normalizedCandidateName = normalizeForCompare(candidate.name);

    if (selectedGame && candidate.game === normalizeGame(selectedGame)) {
      score += 0.1;
      reasons.push('selected game matches candidate game +0.10');
    }
    if (extracted.cardNumber && candidate.cardNumber) {
      if (extracted.cardNumber.toLowerCase() === candidate.cardNumber.toLowerCase()) {
        score += 0.45;
        reasons.push('collector/card number exact match +0.45');
      } else {
        score += 0.14;
        reasons.push('candidate has collector/card number but it is not exact +0.14');
      }
    }
    if (extracted.setCode && candidate.setCode) {
      if (extracted.setCode.toLowerCase() === candidate.setCode.toLowerCase()) {
        score += 0.2;
        reasons.push('set code exact match +0.20');
      } else {
        score += 0.04;
        reasons.push('candidate has set code but it is not exact +0.04');
      }
    }

    const nameSimilarity = similarityScore(extracted.name, candidate.name);
    if (nameSimilarity > 0) {
      const boost = nameSimilarity * 0.25;
      score += boost;
      reasons.push(`name similarity ${Math.round(nameSimilarity * 100)}% +${boost.toFixed(2)}`);
    }
    if (normalizedExtractedName && normalizedCandidateName.includes(normalizedExtractedName)) {
      score += 0.08;
      reasons.push('candidate name contains OCR card name +0.08');
    }
    if (normalizedExtractedName && normalizedCandidateName.startsWith(normalizedExtractedName.slice(0, Math.min(4, normalizedExtractedName.length)))) {
      score += 0.05;
      reasons.push('candidate name shares OCR prefix +0.05');
    }
    const raritySimilarity = similarityScore(extracted.rarity, candidate.rarity);
    if (raritySimilarity > 0) {
      const boost = raritySimilarity * 0.05;
      score += boost;
      reasons.push(`rarity similarity ${Math.round(raritySimilarity * 100)}% +${boost.toFixed(2)}`);
    }
    const languageSimilarity = similarityScore(extracted.language, candidate.language);
    if (languageSimilarity > 0) {
      const boost = languageSimilarity * 0.03;
      score += boost;
      reasons.push(`language similarity ${Math.round(languageSimilarity * 100)}% +${boost.toFixed(2)}`);
    }
    if (!extracted.name && extracted.attackNameHint && candidate.source === 'pokemon-tcg-api') {
      score += 0.1;
      reasons.push('text match from Pokemon attack clue +0.10');
    }

    // TODO: replace placeholder with image-embedding similarity score when pgvector retrieval is available.
    score += 0.02;
    reasons.push('image similarity placeholder +0.02');

    return {
      confidence: Math.min(0.99, Math.round(score * 100) / 100),
      reasons
    };
  }
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
