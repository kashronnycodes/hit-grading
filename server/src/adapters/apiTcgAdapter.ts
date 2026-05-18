import { env } from '../config/env.js';
import type { CardCandidate, CardDetails, SupportedGame } from '../types/cards.js';
import { requestJson } from '../utils/http.js';
import { BaseCardAdapter } from './base.js';

type ApiTcgCard = {
  id: string;
  code?: string;
  name: string;
  rarity?: string;
  number?: string;
  images?: { small?: string; large?: string };
  set?: { id?: string; name?: string };
};

type ApiTcgList = {
  data?: ApiTcgCard[];
};

export class ApiTcgAdapter extends BaseCardAdapter {
  readonly source = 'api-tcg';

  constructor(readonly game: SupportedGame, private readonly path: string) {
    super();
  }

  async searchByName(query: string): Promise<CardCandidate[]> {
    const response = await requestJson<ApiTcgList>(
      `${env.API_TCG_BASE_URL}/${this.path}/cards?name=${encodeURIComponent(query)}`,
      { headers: this.headers() },
      { cacheKey: `${this.source}:${this.path}:name:${query}`, ttlMs: 1000 * 60 * 60 }
    );
    return (response.data ?? []).slice(0, 8).map((card) => this.normalize(card));
  }

  async searchByNumber(cardNumber: string): Promise<CardCandidate[]> {
    const response = await requestJson<ApiTcgList>(
      `${env.API_TCG_BASE_URL}/${this.path}/cards?id=${encodeURIComponent(cardNumber)}`,
      { headers: this.headers() },
      { cacheKey: `${this.source}:${this.path}:id:${cardNumber}`, ttlMs: 1000 * 60 * 60 }
    );
    return (response.data ?? []).slice(0, 8).map((card) => this.normalize(card));
  }

  async getCardById(id: string): Promise<CardDetails | null> {
    const cards = await this.searchByNumber(id);
    return cards[0] ?? null;
  }

  private normalize(card: ApiTcgCard): CardDetails {
    return {
      id: card.id,
      source: this.source,
      game: this.game,
      name: card.name,
      setName: card.set?.name,
      setCode: card.set?.id,
      cardNumber: card.code ?? card.number,
      rarity: card.rarity,
      imageUrl: card.images?.large ?? card.images?.small
    };
  }

  private headers() {
    return env.API_TCG_TOKEN ? { Authorization: `Bearer ${env.API_TCG_TOKEN}` } : undefined;
  }
}
