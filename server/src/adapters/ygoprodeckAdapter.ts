import { env } from '../config/env.js';
import type { CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson } from '../utils/http.js';
import { BaseCardAdapter } from './base.js';

type YgoCard = {
  id: number;
  name: string;
  card_sets?: Array<{
    set_name?: string;
    set_code?: string;
    set_rarity?: string;
    set_price?: string;
  }>;
  card_images?: Array<{ image_url?: string; image_url_cropped?: string }>;
};

type YgoResponse = {
  data: YgoCard[];
};

export class YgoprodeckAdapter extends BaseCardAdapter {
  readonly game = 'yugioh' as const;
  readonly source = 'ygoprodeck';

  async searchByName(query: string, language?: string): Promise<CardCandidate[]> {
    const params = new URLSearchParams({ fname: query, num: '8', offset: '0' });
    if (language) params.set('language', this.mapLanguage(language));
    const response = await requestJson<YgoResponse>(
      `${env.YGOPRODECK_API_BASE_URL}/cardinfo.php?${params.toString()}`,
      {},
      { cacheKey: `${this.source}:${params.toString()}`, ttlMs: 1000 * 60 * 30 }
    );
    return response.data.map((card) => this.normalize(card));
  }

  async searchByNumber(cardNumber: string, setCode?: string): Promise<CardCandidate[]> {
    if (!setCode && !cardNumber) return [];
    const params = new URLSearchParams();
    if (setCode) params.set('cardset', setCode);
    if (cardNumber && !setCode) params.set('id', cardNumber);
    try {
      const response = await requestJson<YgoResponse>(
        `${env.YGOPRODECK_API_BASE_URL}/cardinfo.php?${params.toString()}`,
        {},
        { cacheKey: `${this.source}:number:${params.toString()}`, ttlMs: 1000 * 60 * 30 }
      );
      return response.data.map((card) => this.normalize(card, cardNumber, setCode));
    } catch {
      return [];
    }
  }

  async getCardById(id: string): Promise<CardDetails | null> {
    try {
      const response = await requestJson<YgoResponse>(
        `${env.YGOPRODECK_API_BASE_URL}/cardinfo.php?id=${encodeURIComponent(id)}`,
        {},
        { cacheKey: `${this.source}:card:${id}`, ttlMs: 1000 * 60 * 60 }
      );
      return response.data[0] ? this.normalize(response.data[0]) : null;
    } catch {
      return null;
    }
  }

  private normalize(card: YgoCard, numberHint?: string, setCodeHint?: string): CardDetails {
    const set = card.card_sets?.find((entry) => !setCodeHint || entry.set_code?.toLowerCase() === setCodeHint.toLowerCase()) ?? card.card_sets?.[0];
    return {
      id: String(card.id),
      source: this.source,
      game: this.game,
      name: card.name,
      setName: set?.set_name,
      setCode: set?.set_code,
      cardNumber: numberHint,
      rarity: set?.set_rarity,
      imageUrl: card.card_images?.[0]?.image_url_cropped ?? card.card_images?.[0]?.image_url,
      prices: this.buildPrice(set?.set_price, set?.set_price, undefined, set?.set_price, 'USD')
    };
  }

  private mapLanguage(language: string): string {
    const lowered = language.toLowerCase();
    const map: Record<string, string> = { french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', english: 'en' };
    return map[lowered] ?? lowered;
  }
}
