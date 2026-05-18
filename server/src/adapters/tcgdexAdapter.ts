import { env } from '../config/env.js';
import type { CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson } from '../utils/http.js';
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

  async searchByName(query: string, language = 'en'): Promise<CardCandidate[]> {
    const url = `${env.TCGDEX_BASE_URL}/${language}/cards?name=${encodeURIComponent(query)}`;
    const cards = await requestJson<TcgdexCard[]>(
      url,
      {},
      { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 30 }
    );
    return cards.slice(0, 8).map((card) => this.normalize(card));
  }

  async searchByNumber(cardNumber: string, setCode?: string, language = 'en'): Promise<CardCandidate[]> {
    if (!setCode) return [];
    const url = `${env.TCGDEX_BASE_URL}/${language}/sets/${encodeURIComponent(setCode)}/${encodeURIComponent(cardNumber)}`;
    try {
      const card = await requestJson<TcgdexCard>(
        url,
        {},
        { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 60 }
      );
      return [this.normalize(card)];
    } catch {
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
}
