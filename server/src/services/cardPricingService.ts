import type { CardCandidate, PublicCardMatch, PublicDetectedDetails } from '../types/cards.js';
import { globalCache } from '../utils/cache.js';
import { normalizePokemonCardNumberForApi } from '../utils/pokemonText.js';
import { type ProviderFailureType } from '../utils/providerErrors.js';
import { ScrydexPricingError, ScrydexPricingProvider } from '../providers/scrydexPricingProvider.js';

type PricingLogger = (message: string) => void;

export type CardPricingResult = {
  estimatedValue: PublicCardMatch['estimatedValue'] | null;
  providerUsed: string;
  cacheStatus: 'hit' | 'miss' | 'skipped';
  scrydexCalled: boolean;
  scrydexSkippedReason?: string;
  selectedPriceField?: string;
  errorType?: ProviderFailureType;
};

export class CardPricingService {
  constructor(private readonly scrydexPricingProvider = new ScrydexPricingProvider()) {}

  async priceCard(input: {
    officialMatch?: PublicCardMatch | null;
    bestCandidate?: CardCandidate;
    detectedDetails: PublicDetectedDetails;
    confidenceScore?: number;
    numberConflict?: boolean;
    pricingEligible?: boolean;
    confirmedIdentity?: boolean;
    userConfirmed?: boolean;
    log?: PricingLogger;
  }): Promise<CardPricingResult> {
    if (!input.pricingEligible && !input.confirmedIdentity && !input.userConfirmed) {
      input.log?.('Pricing skipped: identity_not_confirmed');
      return {
        estimatedValue: null,
        providerUsed: 'none',
        cacheStatus: 'skipped',
        scrydexCalled: false,
        scrydexSkippedReason: 'identity_not_confirmed',
        selectedPriceField: 'none'
      };
    }

    const cacheKey = buildPricingCacheKey(input.officialMatch, input.bestCandidate, input.detectedDetails);
    const cached = cacheKey ? globalCache.get<PublicCardMatch['estimatedValue']>(cacheKey) : null;
    if (cached) {
      input.log?.('pricing cache hit');
      return {
        estimatedValue: cached,
        providerUsed: cached.source ?? 'cache',
        cacheStatus: 'hit',
        scrydexCalled: false,
        selectedPriceField: 'cache'
      };
    }

    const scrydexReadiness = this.getScrydexReadiness(input);
    if (scrydexReadiness.ok && input.officialMatch?.id) {
      input.log?.('Scrydex pricing called');
      try {
        const scrydex = await this.scrydexPricingProvider.getCardPricing(input.officialMatch.id);
        if (cacheKey) globalCache.set(cacheKey, scrydex.estimatedValue, 1000 * 60 * 60 * 24);
        return {
          estimatedValue: scrydex.estimatedValue,
          providerUsed: scrydex.provider,
          cacheStatus: 'miss',
          scrydexCalled: true,
          selectedPriceField: scrydex.selectedPriceField
        };
      } catch (error) {
        const errorType = error instanceof ScrydexPricingError ? error.type : 'provider_down';
        input.log?.(`Scrydex pricing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        const fallback = getProviderFallbackPrice(input.bestCandidate, input.officialMatch);
        if (fallback) {
          return {
            estimatedValue: fallback,
            providerUsed: fallback.source ?? 'tcgdex',
            cacheStatus: 'miss',
            scrydexCalled: true,
            selectedPriceField: fallback.source ?? 'provider_fallback',
            errorType
          };
        }
        return {
          estimatedValue: null,
          providerUsed: 'no_pricing_available',
          cacheStatus: 'miss',
          scrydexCalled: true,
          selectedPriceField: 'none',
          errorType: errorType === 'no_results' ? 'no_pricing_available' : errorType
        };
      }
    }

    input.log?.(`Scrydex skipped: ${scrydexReadiness.reason}`);
    const fallback = getProviderFallbackPrice(input.bestCandidate, input.officialMatch);
    if (fallback) {
      if (cacheKey) globalCache.set(cacheKey, fallback, 1000 * 60 * 60 * 24);
      return {
        estimatedValue: fallback,
        providerUsed: fallback.source ?? 'tcgdex',
        cacheStatus: 'miss',
        scrydexCalled: false,
        scrydexSkippedReason: scrydexReadiness.reason,
        selectedPriceField: fallback.source ?? 'provider_fallback'
      };
    }

    return {
      estimatedValue: null,
      providerUsed: 'no_pricing_available',
      cacheStatus: cacheKey ? 'miss' : 'skipped',
      scrydexCalled: false,
      scrydexSkippedReason: scrydexReadiness.reason,
      selectedPriceField: 'none',
      errorType: 'no_pricing_available'
    };
  }

  private getScrydexReadiness(input: {
    officialMatch?: PublicCardMatch | null;
    confidenceScore?: number;
    numberConflict?: boolean;
  }): { ok: boolean; reason?: string } {
    const providerReady = this.scrydexPricingProvider.canCall();
    if (!providerReady.ok) return providerReady;
    if (input.numberConflict) return { ok: false, reason: 'number_conflict' };
    if (!input.officialMatch) return { ok: false, reason: 'no_confirmed_identity' };
    if ((input.confidenceScore ?? input.officialMatch.confidenceScore ?? 0) < 0.85) return { ok: false, reason: 'identification confidence below Scrydex threshold' };
    if (!input.officialMatch.cardName || (!input.officialMatch.cardNumber && !input.officialMatch.setCode && !input.officialMatch.setSeries)) {
      return { ok: false, reason: 'identity missing card number or set info' };
    }
    return { ok: true };
  }
}

function buildPricingCacheKey(
  officialMatch: PublicCardMatch | null | undefined,
  bestCandidate: CardCandidate | undefined,
  detectedDetails: PublicDetectedDetails
): string | undefined {
  const id = officialMatch?.id || bestCandidate?.id;
  const name = officialMatch?.cardName || bestCandidate?.name || detectedDetails.cardName;
  const number = officialMatch?.cardNumber || bestCandidate?.cardNumber || detectedDetails.cardNumber;
  const set = officialMatch?.setCode || officialMatch?.setSeries || bestCandidate?.setCode || bestCandidate?.setName || detectedDetails.setCode || detectedDetails.setSeries;
  const compact = [id, name, normalizePokemonCardNumberForApi(number ?? undefined) ?? number, set]
    .filter(Boolean)
    .join(':')
    .toLowerCase()
    .replace(/[^a-z0-9:/-]+/g, '');
  return compact ? `pricing:${compact}` : undefined;
}

function getProviderFallbackPrice(bestCandidate?: CardCandidate, officialMatch?: PublicCardMatch | null): PublicCardMatch['estimatedValue'] | null {
  const price = bestCandidate?.prices ?? officialMatch?.estimatedValue;
  if (!price) return null;
  const amount = price.amount ?? price.market ?? price.mid ?? price.low ?? price.high;
  return {
    ...price,
    amount,
    label: price.label ?? (amount ? `$${amount.toFixed(2)} estimate` : undefined)
  };
}
