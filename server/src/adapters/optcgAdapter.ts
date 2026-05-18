import { env } from '../config/env.js';
import type { CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson } from '../utils/http.js';
import { BaseCardAdapter } from './base.js';

type OptcgCard = {
  code?: string;
  id?: string;
  rarity?: string;
  name: string;
  images?: { small?: string; large?: string };
  set?: { name?: string; id?: string };
};

export class OptcgAdapter extends BaseCardAdapter {
  readonly game = 'onepiece' as const;
  readonly source = 'optcgapi';

  async searchByName(query: string): Promise<CardCandidate[]> {
    const response = await requestJson<OptcgCard[] | { data?: OptcgCard[] }>(
      `${env.OPTCG_API_BASE_URL}/allSetCards/`,
      {},
      { cacheKey: `${this.source}:allSetCards`, ttlMs: 1000 * 60 * 60 * 12 }
    );
    const cards = Array.isArray(response) ? response : response.data ?? [];
    return cards.filter((card) => card.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map((card) => this.normalize(card));
  }

  async searchByNumber(cardNumber: string): Promise<CardCandidate[]> {
    try {
      const card = await requestJson<OptcgCard>(
        `${env.OPTCG_API_BASE_URL}/sets/card/${encodeURIComponent(cardNumber)}/`,
        {},
        { cacheKey: `${this.source}:${cardNumber}`, ttlMs: 1000 * 60 * 60 * 12 }
      );
      return [this.normalize(card)];
    } catch {
      return [];
    }
  }

  async getCardById(id: string): Promise<CardDetails | null> {
    const cards = await this.searchByNumber(id);
    return cards[0] ?? null;
  }

  private normalize(card: OptcgCard): CardDetails {
    return {
      id: card.code ?? card.id ?? card.name,
      source: this.source,
      game: this.game,
      name: card.name,
      setName: card.set?.name,
      setCode: card.set?.id,
      cardNumber: card.code ?? card.id,
      rarity: card.rarity,
      imageUrl: card.images?.large ?? card.images?.small
    };
  }
}
