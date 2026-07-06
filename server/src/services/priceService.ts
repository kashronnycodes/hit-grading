import type { CardCandidate } from '../types/cards.js';

export class PriceService {
  enrichCandidate(candidate: CardCandidate): CardCandidate {
    if (candidate.prices?.market) return candidate;
    const existingPrices = candidate.prices;
    if (!existingPrices) return candidate;

    const market = existingPrices.mid ?? existingPrices.high ?? existingPrices.low;
    return {
      ...candidate,
      prices: {
        market,
        low: existingPrices.low,
        mid: existingPrices.mid,
        high: existingPrices.high,
        currency: existingPrices.currency ?? 'USD',
        source: existingPrices.source
      }
    };
  }
}
