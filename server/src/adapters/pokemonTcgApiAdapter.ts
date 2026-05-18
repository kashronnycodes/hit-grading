import { env } from '../config/env.js';
import type { CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson } from '../utils/http.js';
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

  async searchByName(query: string): Promise<CardCandidate[]> {
    const q = encodeURIComponent(`name:"${query}"`);
    const data = await this.fetchCards(`${env.POKEMON_TCG_API_BASE_URL}/cards?q=${q}&pageSize=8`);
    return data.map((card) => this.normalize(card));
  }

  async searchByNumber(cardNumber: string, setCode?: string): Promise<CardCandidate[]> {
    const parts = [`number:${cardNumber}`];
    if (setCode) parts.push(`set.id:${setCode}`);
    const q = encodeURIComponent(parts.join(' '));
    const data = await this.fetchCards(`${env.POKEMON_TCG_API_BASE_URL}/cards?q=${q}&pageSize=8`);
    return data.map((card) => this.normalize(card));
  }

  async getCardById(id: string): Promise<CardDetails | null> {
    const response = await requestJson<{ data: PokemonCardResponse['data'][number] }>(
      `${env.POKEMON_TCG_API_BASE_URL}/cards/${id}`,
      { headers: this.headers() },
      { cacheKey: `${this.source}:card:${id}`, ttlMs: 1000 * 60 * 60 }
    );
    return this.normalize(response.data);
  }

  private async fetchCards(url: string) {
    const response = await requestJson<PokemonCardResponse>(
      url,
      { headers: this.headers() },
      { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 10 }
    );
    return response.data;
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
