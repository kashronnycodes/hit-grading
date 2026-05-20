import { env } from '../config/env.js';
import type { ApiSearchDebugEntry, CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson, requestJsonWithMeta } from '../utils/http.js';
import { BaseCardAdapter } from './base.js';

type TcgdexCard = {
  id: string;
  localId?: string;
  name: string;
  rarity?: string;
  image?: string;
  set?: { id?: string; name?: string };
  pricing?: {
    low?: number;
    average?: number;
    high?: number;
    trend?: number;
  };
};

export class TcgdexAdapter extends BaseCardAdapter {
  readonly game = 'pokemon' as const;
  readonly source = 'tcgdex';

  async searchByName(query: string, language = 'en', debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    const url = `${env.TCGDEX_BASE_URL}/${language}/cards?name=${encodeURIComponent(query)}`;
    try {
      const response = await requestJsonWithMeta<TcgdexCard[]>(
        url,
        {},
        { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 30 }
      );
      debugCollector?.push({
        source: this.source,
        searchType: 'name',
        query,
        endpoint: url,
        status: response.status,
        resultCount: response.data.length,
        topMatchName: response.data[0]?.name
      });
      const hydrated = await this.hydrateCards(response.data.slice(0, 5), language);
      return hydrated.map((card) => this.normalize(card));
    } catch (error) {
      debugCollector?.push({
        source: this.source,
        searchType: 'name',
        query,
        endpoint: url,
        error: error instanceof Error ? error.message : 'Unknown adapter error'
      });
      throw error;
    }
  }

  async searchByNumber(cardNumber: string, setCode?: string, language = 'en', debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    if (!setCode) return [];
    const normalizedSetCode = normalizeTcgdexSetCode(setCode);
    const url = `${env.TCGDEX_BASE_URL}/${language}/sets/${encodeURIComponent(normalizedSetCode)}/${encodeURIComponent(cardNumber)}`;
    try {
      const response = await requestJsonWithMeta<TcgdexCard>(
        url,
        {},
        { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 60 }
      );
      debugCollector?.push({
        source: this.source,
        searchType: 'number',
        query: `${cardNumber}${setCode ? ` ${setCode}` : ''}`,
        endpoint: url,
        status: response.status,
        resultCount: response.data ? 1 : 0,
        topMatchName: response.data?.name
      });
      return [this.normalize(response.data)];
    } catch (error) {
      debugCollector?.push({
        source: this.source,
        searchType: 'number',
        query: `${cardNumber}${setCode ? ` ${setCode}` : ''}`,
        endpoint: url,
        error: error instanceof Error ? error.message : 'Unknown adapter error'
      });
      return [];
    }
  }

  async getCardById(id: string, language = 'en'): Promise<CardDetails | null> {
    const url = `${env.TCGDEX_BASE_URL}/${language}/cards/${encodeURIComponent(id)}`;
    try {
      const card = await requestJson<TcgdexCard>(
        url,
        {},
        { cacheKey: `${this.source}:card:${id}:${language}`, ttlMs: 1000 * 60 * 60 }
      );
      return this.normalize(card);
    } catch {
      return null;
    }
  }

  private normalize(card: TcgdexCard): CardDetails {
    return {
      id: card.id,
      source: this.source,
      game: this.game,
      name: card.name,
      setName: card.set?.name,
      setCode: card.set?.id,
      cardNumber: card.localId,
      rarity: card.rarity,
      imageUrl: card.image,
      prices: this.buildPrice(card.pricing?.trend, card.pricing?.low, card.pricing?.average, card.pricing?.high, 'USD')
    };
  }

  private async hydrateCards(cards: TcgdexCard[], language: string): Promise<TcgdexCard[]> {
    const hydrated = await Promise.all(
      cards.map(async (card) => {
        try {
          const detailed = await this.getCardById(card.id, language);
          if (!detailed) return card;
          return {
            id: detailed.id,
            localId: detailed.cardNumber,
            name: detailed.name,
            rarity: detailed.rarity,
            image: detailed.imageUrl,
            set: detailed.setCode || detailed.setName
              ? {
                  id: detailed.setCode,
                  name: detailed.setName
                }
              : undefined,
            pricing: detailed.prices
              ? {
                  low: detailed.prices.low,
                  average: detailed.prices.mid,
                  high: detailed.prices.high,
                  trend: detailed.prices.market
                }
              : undefined
          } satisfies TcgdexCard;
        } catch {
          return card;
        }
      })
    );
    return hydrated;
  }
}

function normalizeTcgdexSetCode(setCode: string): string {
  const compact = setCode.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact.startsWith('svpen') || compact === 'svp') return 'svp';
  return compact || setCode.toLowerCase();
}
