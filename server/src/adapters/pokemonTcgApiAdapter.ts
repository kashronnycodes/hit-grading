import { env } from '../config/env.js';
import type { ApiSearchDebugEntry, CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson, requestJsonWithMeta } from '../utils/http.js';
import { BaseCardAdapter } from './base.js';

type PokemonCardResponse = {
  data: Array<{
    id: string;
    name: string;
    number?: string;
    rarity?: string;
    images?: { small?: string; large?: string };
    set?: { id?: string; name?: string };
    tcgplayer?: {
      prices?: Record<string, { low?: number; mid?: number; high?: number; market?: number }>;
    };
    cardmarket?: {
      prices?: { averageSellPrice?: number; lowPrice?: number; trendPrice?: number };
    };
  }>;
};

export class PokemonTcgApiAdapter extends BaseCardAdapter {
  readonly game = 'pokemon' as const;
  readonly source = 'pokemon-tcg-api';

  async searchByName(query: string, _language?: string, debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const wildcardPrefix = trimmed.replace(/[^a-z0-9]+/gi, '').slice(0, Math.min(4, trimmed.length));
    const searches = [
      { query: `name:${trimmed}`, label: trimmed },
      { query: `name:"${trimmed}"`, label: trimmed }
    ];
    if (wildcardPrefix) {
      searches.push({ query: `name:${wildcardPrefix}*`, label: `${wildcardPrefix}*` });
    }

    const candidates: CardCandidate[] = [];
    const seen = new Set<string>();
    for (const search of searches) {
      const url = `${env.POKEMON_TCG_API_BASE_URL}/cards?q=${encodeURIComponent(search.query)}&pageSize=10`;
      const data = await this.fetchCards(url, debugCollector, 'name', search.label).catch(() => []);
      for (const card of data) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        candidates.push(this.normalize(card));
      }
    }
    return candidates;
  }

  async searchByNumber(cardNumber: string, setCode?: string, _language?: string, debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    const parts = [`number:${cardNumber}`];
    const normalizedSetId = normalizePokemonSetId(setCode);
    if (normalizedSetId) parts.push(`set.id:${normalizedSetId}`);
    const q = encodeURIComponent(parts.join(' '));
    const data = await this.fetchCards(`${env.POKEMON_TCG_API_BASE_URL}/cards?q=${q}&pageSize=8`, debugCollector, 'number', parts.join(' '));
    return data.map((card) => this.normalize(card));
  }

  async searchByCompositeHints(
    hints: { name?: string; cardNumber?: string; setCode?: string },
    debugCollector?: ApiSearchDebugEntry[]
  ): Promise<CardCandidate[]> {
    if (!hints.cardNumber || !hints.name) return [];
    const wildcardPrefix = hints.name.replace(/[^a-z0-9]+/gi, '').slice(0, Math.min(4, hints.name.length));
    if (!wildcardPrefix) return [];

    const parts = [`number:${hints.cardNumber}`, `name:${wildcardPrefix}*`];
    const normalizedSetId = normalizePokemonSetId(hints.setCode);
    if (normalizedSetId) parts.push(`set.id:${normalizedSetId}`);
    const query = parts.join(' ');
    const data = await this.fetchCards(
      `${env.POKEMON_TCG_API_BASE_URL}/cards?q=${encodeURIComponent(query)}&pageSize=12`,
      debugCollector,
      'number',
      query
    ).catch(() => []);
    return data.map((card) => this.normalize(card));
  }

  async searchByNameAndSet(name: string, setCode: string, debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    const trimmed = name.trim();
    const normalizedSetId = normalizePokemonSetId(setCode);
    if (!trimmed || !normalizedSetId) return [];
    const wildcardPrefix = trimmed.replace(/[^a-z0-9]+/gi, '').slice(0, Math.min(4, trimmed.length));
    if (!wildcardPrefix) return [];
    const query = `name:${wildcardPrefix}* set.id:${normalizedSetId}`;
    const data = await this.fetchCards(
      `${env.POKEMON_TCG_API_BASE_URL}/cards?q=${encodeURIComponent(query)}&pageSize=12`,
      debugCollector,
      'name',
      query
    ).catch(() => []);
    return data.map((card) => this.normalize(card));
  }

  async searchByAttackName(query: string, debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const wildcardPrefix = trimmed.replace(/[^a-z0-9]+/gi, '').slice(0, Math.min(4, trimmed.length));
    const searches = [
      { query: `attacks.name:"${trimmed}"`, label: trimmed }
    ];
    if (wildcardPrefix) {
      searches.push({ query: `attacks.name:${wildcardPrefix}*`, label: `${wildcardPrefix}*` });
    }

    const candidates: CardCandidate[] = [];
    const seen = new Set<string>();
    for (const search of searches) {
      const url = `${env.POKEMON_TCG_API_BASE_URL}/cards?q=${encodeURIComponent(search.query)}&pageSize=8`;
      const data = await this.fetchCards(url, debugCollector, 'attack', search.label).catch(() => []);
      for (const card of data) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        candidates.push(this.normalize(card));
      }
    }
    return candidates;
  }

  async getCardById(id: string): Promise<CardDetails | null> {
    const response = await requestJson<{ data: PokemonCardResponse['data'][number] }>(
      `${env.POKEMON_TCG_API_BASE_URL}/cards/${id}`,
      { headers: this.headers() },
      { cacheKey: `${this.source}:card:${id}`, ttlMs: 1000 * 60 * 60 }
    );
    return this.normalize(response.data);
  }

  private async fetchCards(
    url: string,
    debugCollector?: ApiSearchDebugEntry[],
    searchType: ApiSearchDebugEntry['searchType'] = 'name',
    query = ''
  ) {
    try {
      const response = await requestJsonWithMeta<PokemonCardResponse>(
        url,
        { headers: this.headers() },
        { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 10 }
      );
      debugCollector?.push({
        source: this.source,
        searchType,
        query,
        endpoint: url,
        status: response.status,
        resultCount: response.data.data.length,
        topMatchName: response.data.data[0]?.name
      });
      return response.data.data;
    } catch (error) {
      debugCollector?.push({
        source: this.source,
        searchType,
        query,
        endpoint: url,
        error: error instanceof Error ? error.message : 'Unknown adapter error'
      });
      throw error;
    }
  }

  private normalize(card: PokemonCardResponse['data'][number]): CardDetails {
    const tcgPlayerPrice = card.tcgplayer?.prices ? Object.values(card.tcgplayer.prices)[0] : undefined;
    const cardMarket = card.cardmarket?.prices;
    return {
      id: card.id,
      source: this.source,
      game: this.game,
      name: card.name,
      setName: card.set?.name,
      setCode: card.set?.id,
      cardNumber: card.number,
      rarity: card.rarity,
      imageUrl: card.images?.large ?? card.images?.small,
      prices:
        this.buildPrice(
          tcgPlayerPrice?.market ?? cardMarket?.averageSellPrice,
          tcgPlayerPrice?.low ?? cardMarket?.lowPrice,
          tcgPlayerPrice?.mid ?? cardMarket?.trendPrice,
          tcgPlayerPrice?.high,
          'USD'
        ) ?? undefined
    };
  }

  private headers() {
    return env.POKEMON_TCG_API_KEY ? { 'X-Api-Key': env.POKEMON_TCG_API_KEY } : undefined;
  }
}

function normalizePokemonSetId(setCode?: string): string | undefined {
  if (!setCode) return undefined;
  const compact = setCode.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact.startsWith('svpen') || compact === 'svp') return 'svp';
  if (compact.startsWith('swsh')) return compact;
  if (compact.startsWith('sv')) return compact;
  if (compact.startsWith('sm')) return compact;
  if (compact.startsWith('xy')) return compact;
  if (compact.startsWith('bw')) return compact;
  return compact || undefined;
}
