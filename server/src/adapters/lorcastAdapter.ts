import { env } from '../config/env.js';
import type { CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson } from '../utils/http.js';
import { BaseCardAdapter } from './base.js';

type LorcastCard = {
  id: string;
  name: string;
  version?: string;
  image_uris?: { digital?: { normal?: string; large?: string } };
  set?: { id?: string; name?: string };
  rarity?: string;
  collector_number?: string;
  prices?: { usd?: { market?: number; low?: number; high?: number } };
};

type LorcastSearchResponse = {
  results: LorcastCard[];
};

export class LorcastAdapter extends BaseCardAdapter {
  readonly game = 'lorcana' as const;
  readonly source = 'lorcast';

  async searchByName(query: string): Promise<CardCandidate[]> {
    const url = `${env.LORCAST_API_BASE_URL}/cards/search?q=${encodeURIComponent(query)}&unique=prints`;
    const response = await requestJson<LorcastSearchResponse>(
      url,
      {},
      { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 60 * 24 }
    );
    return response.results.slice(0, 8).map((card) => this.normalize(card));
  }

  async searchByNumber(cardNumber: string, setCode?: string): Promise<CardCandidate[]> {
    if (!setCode) return [];
    try {
      const card = await requestJson<LorcastCard>(
        `${env.LORCAST_API_BASE_URL}/cards/${encodeURIComponent(setCode)}/${encodeURIComponent(cardNumber)}`,
        {},
        { cacheKey: `${this.source}:${setCode}:${cardNumber}`, ttlMs: 1000 * 60 * 60 * 24 }
      );
      return [this.normalize(card)];
    } catch {
      return [];
    }
  }

  async getCardById(id: string): Promise<CardDetails | null> {
    try {
      const card = await requestJson<LorcastCard>(
        `${env.LORCAST_API_BASE_URL}/cards/${encodeURIComponent(id)}`,
        {},
        { cacheKey: `${this.source}:card:${id}`, ttlMs: 1000 * 60 * 60 * 24 }
      );
      return this.normalize(card);
    } catch {
      return null;
    }
  }

  private normalize(card: LorcastCard): CardDetails {
    return {
      id: card.id,
      source: this.source,
      game: this.game,
      name: [card.name, card.version].filter(Boolean).join(' - '),
      setName: card.set?.name,
      setCode: card.set?.id,
      cardNumber: card.collector_number,
      rarity: card.rarity,
      imageUrl: card.image_uris?.digital?.large ?? card.image_uris?.digital?.normal,
      prices: this.buildPrice(card.prices?.usd?.market, card.prices?.usd?.low, undefined, card.prices?.usd?.high, 'USD')
    };
  }
}
