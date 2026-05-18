import type { CardApiAdapter, CardCandidate, CardDetails, SupportedGame } from '../types/cards.js';

export abstract class BaseCardAdapter implements CardApiAdapter {
  abstract readonly game: SupportedGame;
  abstract readonly source: string;

  abstract searchByName(query: string, language?: string): Promise<CardCandidate[]>;
  abstract searchByNumber(cardNumber: string, setCode?: string, language?: string): Promise<CardCandidate[]>;
  abstract getCardById(id: string, language?: string): Promise<CardDetails | null>;

  protected buildPrice(
    market?: number | string | null,
    low?: number | string | null,
    mid?: number | string | null,
    high?: number | string | null,
    currency = 'USD'
  ): CardCandidate['prices'] | undefined {
    const numeric = [market, low, mid, high].some((value) => value !== null && value !== undefined && value !== '');
    if (!numeric) return undefined;
    return {
      market: toNumber(market),
      low: toNumber(low),
      mid: toNumber(mid),
      high: toNumber(high),
      currency
    };
  }
}

function toNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(num) ? num : undefined;
}
