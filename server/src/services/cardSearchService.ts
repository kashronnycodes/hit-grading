import { ApiTcgAdapter } from '../adapters/apiTcgAdapter.js';
import { LorcastAdapter } from '../adapters/lorcastAdapter.js';
import { OptcgAdapter } from '../adapters/optcgAdapter.js';
import { PokemonTcgApiAdapter } from '../adapters/pokemonTcgApiAdapter.js';
import { ScryfallAdapter } from '../adapters/scryfallAdapter.js';
import { TcgdexAdapter } from '../adapters/tcgdexAdapter.js';
import { YgoprodeckAdapter } from '../adapters/ygoprodeckAdapter.js';
import type { CardApiAdapter, CardCandidate, ExtractedCardDetails, SupportedGame } from '../types/cards.js';
import { similarityScore } from '../utils/fuzzy.js';

export class CardSearchService {
  private readonly adapters: CardApiAdapter[] = [
    new PokemonTcgApiAdapter(),
    new TcgdexAdapter(),
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

    const adapterResults = await Promise.all(
      adapters.map(async (adapter) => ({
        adapter,
        matches: await this.fetchAdapterMatches(adapter, extracted, selectedLanguage, queriesUsed).catch(() => [])
      }))
    );

    for (const { matches } of adapterResults) {
      for (const candidate of matches) {
        const scored = {
          ...candidate,
          confidence: this.rankCandidate(candidate, extracted, selectedGame)
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
      queriesUsed
    };
  }

  private async fetchAdapterMatches(
    adapter: CardApiAdapter,
    extracted: ExtractedCardDetails,
    language: string | undefined,
    queriesUsed: string[]
  ) {
    const results: CardCandidate[] = [];

    if (extracted.cardNumber) {
      queriesUsed.push(`${adapter.source}:number:${extracted.cardNumber}:${extracted.setCode ?? ''}`);
      const byNumber = await adapter.searchByNumber(extracted.cardNumber, extracted.setCode, language);
      results.push(...byNumber);
    }

    if (extracted.name) {
      queriesUsed.push(`${adapter.source}:name:${extracted.name}`);
      const byName = await adapter.searchByName(extracted.name, language);
      results.push(...byName);
    }

    return results;
  }

  private selectAdapters(selectedGame?: string): CardApiAdapter[] {
    if (!selectedGame) return [];
    const normalized = normalizeGame(selectedGame);
    return this.adapters.filter((adapter) => adapter.game === normalized);
  }

  private rankCandidate(candidate: CardCandidate, extracted: ExtractedCardDetails, selectedGame?: string): number {
    let score = 0.12;

    if (selectedGame && candidate.game === normalizeGame(selectedGame)) score += 0.1;
    if (extracted.cardNumber && candidate.cardNumber) {
      score += extracted.cardNumber.toLowerCase() === candidate.cardNumber.toLowerCase() ? 0.45 : 0.14;
    }
    if (extracted.setCode && candidate.setCode) {
      score += extracted.setCode.toLowerCase() === candidate.setCode.toLowerCase() ? 0.2 : 0.04;
    }

    score += similarityScore(extracted.name, candidate.name) * 0.25;
    score += similarityScore(extracted.rarity, candidate.rarity) * 0.05;
    score += similarityScore(extracted.language, candidate.language) * 0.03;

    score += 0.02;

    return Math.min(0.99, Math.round(score * 100) / 100);
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
