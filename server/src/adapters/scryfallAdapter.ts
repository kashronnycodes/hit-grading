import { env } from '../config/env.js';
import type { CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson } from '../utils/http.js';
import { BaseCardAdapter } from './base.js';

type ScryfallCard = {
  id: string;
  name: string;
  set?: string;
  set_name?: string;
  collector_number?: string;
  rarity?: string;
  lang?: string;
  image_uris?: { normal?: string; large?: string };
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
  oracle_text?: string;
};

type ScryfallList = {
  data: ScryfallCard[];
};

export class ScryfallAdapter extends BaseCardAdapter {
  readonly game = 'magic' as const;
  readonly source = 'scryfall';

  async searchByName(query: string): Promise<CardCandidate[]> {
    const q = encodeURIComponent(`!"${query}" or ${query}`);
    const url = `${env.SCRYFALL_API_BASE_URL}/cards/search?q=${q}&unique=prints&order=released`;
    const response = await requestJson<ScryfallList>(
      url,
      { headers: this.headers() },
      { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 30 }
    );
    return response.data.slice(0, 8).map((card) => this.normalize(card));
  }

  async searchByNumber(cardNumber: string, setCode?: string): Promise<CardCandidate[]> {
    const terms = [`cn:${cardNumber}`];
    if (setCode) terms.push(`set:${setCode.toLowerCase()}`);
    const q = encodeURIComponent(terms.join(' '));
    try {
      const response = await requestJson<ScryfallList>(
        `${env.SCRYFALL_API_BASE_URL}/cards/search?q=${q}&unique=prints`,
        { headers: this.headers() },
        { cacheKey: `${this.source}:number:${q}`, ttlMs: 1000 * 60 * 30 }
      );
      return response.data.slice(0, 8).map((card) => this.normalize(card));
    } catch {
      return [];
    }
  }

  async getCardById(id: string): Promise<CardDetails | null> {
    try {
      const response = await requestJson<ScryfallCard>(
        `${env.SCRYFALL_API_BASE_URL}/cards/${id}`,
        { headers: this.headers() },
        { cacheKey: `${this.source}:card:${id}`, ttlMs: 1000 * 60 * 60 }
      );
      return this.normalize(response);
    } catch {
      return null;
    }
  }

  private normalize(card: ScryfallCard): CardDetails {
    return {
      id: card.id,
      source: this.source,
      game: this.game,
      name: card.name,
      setName: card.set_name,
      setCode: card.set,
      cardNumber: card.collector_number,
      rarity: card.rarity,
      language: card.lang,
      imageUrl: card.image_uris?.large ?? card.image_uris?.normal,
      prices: this.buildPrice(card.prices?.usd ?? card.prices?.usd_foil, card.prices?.usd, undefined, card.prices?.usd_foil, 'USD'),
      description: card.oracle_text
    };
  }

  private headers() {
    return {
      'User-Agent': 'speedy-comics-hit-grading/1.0',
      Accept: 'application/json;q=0.9,*/*;q=0.8'
    };
  }
}
