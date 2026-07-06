import { env } from '../config/env.js';
import type { PublicCardMatch } from '../types/cards.js';
import { requestJsonWithMeta } from '../utils/http.js';
import { classifyProviderError, type ProviderFailureType } from '../utils/providerErrors.js';

type ScrydexPriceRecord = {
  condition?: string;
  type?: string;
  low?: number;
  mid?: number;
  high?: number;
  market?: number;
  currency?: string;
};

type ScrydexCardResponse = {
  id?: string;
  name?: string;
  number?: string;
  printed_number?: string;
  variants?: Array<{
    name?: string;
    prices?: ScrydexPriceRecord[];
  }>;
  prices?: ScrydexPriceRecord[];
};

export type ScrydexPricingResult = {
  estimatedValue: NonNullable<PublicCardMatch['estimatedValue']>;
  selectedPriceField: string;
  provider: 'scrydex';
};

export class ScrydexPricingProvider {
  canCall(): { ok: boolean; reason?: string } {
    if (!env.SCRYDEX_ENABLED) return { ok: false, reason: 'SCRYDEX_ENABLED is false' };
    if (!env.SCRYDEX_API_KEY || !env.SCRYDEX_TEAM_ID) return { ok: false, reason: 'missing_api_key' };
    return { ok: true };
  }

  async getCardPricing(cardId: string): Promise<ScrydexPricingResult> {
    const url = `${env.SCRYDEX_API_BASE_URL}/pokemon/v1/cards/${encodeURIComponent(cardId)}?include=prices&casing=snake`;
    try {
      const response = await requestJsonWithMeta<ScrydexCardResponse>(
        url,
        {
          headers: {
            'X-Api-Key': env.SCRYDEX_API_KEY,
            'X-Team-ID': env.SCRYDEX_TEAM_ID,
            Accept: 'application/json'
          },
          timeout: 10000
        },
        { retries: 1 }
      );
      const normalized = extractScrydexPrice(response.data);
      if (!normalized) throw new ScrydexPricingError('No pricing available from Scrydex for this card.', 'no_pricing_available');
      return normalized;
    } catch (error) {
      if (error instanceof ScrydexPricingError) throw error;
      throw new ScrydexPricingError(
        error instanceof Error ? error.message : 'Scrydex pricing failed.',
        classifyProviderError(error)
      );
    }
  }
}

export class ScrydexPricingError extends Error {
  constructor(message: string, readonly type: ProviderFailureType) {
    super(message);
    this.name = 'ScrydexPricingError';
  }
}

function extractScrydexPrice(card: ScrydexCardResponse): ScrydexPricingResult | null {
  const variantPrices = card.variants?.flatMap((variant) =>
    (variant.prices ?? []).map((price) => ({
      ...price,
      selectedFieldPrefix: `variants.${variant.name ?? 'default'}.prices`
    }))
  ) ?? [];
  const prices = [
    ...variantPrices,
    ...(card.prices ?? []).map((price) => ({ ...price, selectedFieldPrefix: 'prices' }))
  ];

  const preferred = prices
    .filter((price) => !price.type || price.type === 'raw')
    .sort((a, b) => conditionRank(b.condition) - conditionRank(a.condition));

  for (const price of preferred) {
    const field = [
      { key: 'market', value: price.market },
      { key: 'mid', value: price.mid },
      { key: 'low', value: price.low },
      { key: 'high', value: price.high }
    ].find((entry) => typeof entry.value === 'number' && Number.isFinite(entry.value));
    if (!field?.value) continue;
    return {
      provider: 'scrydex',
      selectedPriceField: `${price.selectedFieldPrefix}.${field.key}`,
      estimatedValue: {
        amount: field.value,
        market: field.key === 'market' ? field.value : undefined,
        low: price.low,
        mid: price.mid,
        high: price.high,
        currency: price.currency ?? 'USD',
        source: 'scrydex',
        label: `${currencySymbol(price.currency ?? 'USD')}${field.value.toFixed(2)} ${field.key === 'market' ? 'market' : 'estimate'}`
      }
    };
  }

  return null;
}

function conditionRank(condition?: string): number {
  const normalized = String(condition ?? '').toUpperCase();
  if (normalized === 'NM') return 5;
  if (normalized === 'LP') return 4;
  if (normalized === 'MP') return 3;
  if (normalized === 'HP') return 2;
  if (normalized === 'DM') return 1;
  return 0;
}

function currencySymbol(currency: string): string {
  if (currency.toUpperCase() === 'EUR') return '€';
  if (currency.toUpperCase() === 'GBP') return '£';
  return '$';
}
