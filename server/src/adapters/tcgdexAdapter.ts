import { env } from '../config/env.js';
import type { ApiSearchDebugEntry, CardCandidate, CardDetails } from '../types/cards.js';
import { requestJson, requestJsonWithMeta } from '../utils/http.js';
import { normalizePokemonCardNumberForApi } from '../utils/pokemonText.js';
import { classifyProviderError } from '../utils/providerErrors.js';
import { BaseCardAdapter } from './base.js';

type TcgdexCard = {
  id: string;
  localId?: string;
  name: string;
  rarity?: string;
  hp?: string | number;
  image?: string;
  set?: { id?: string; name?: string; cardCount?: { official?: number; total?: number } };
  pricing?: {
    tcgplayer?: Record<string, { lowPrice?: number; midPrice?: number; highPrice?: number; marketPrice?: number } | number | undefined>;
    cardmarket?: {
      avg?: number;
      low?: number;
      trend?: number;
      'avg-holo'?: number;
      'low-holo'?: number;
      'trend-holo'?: number;
    };
  };
};

export class TcgdexAdapter extends BaseCardAdapter {
  readonly game = 'pokemon' as const;
  readonly source = 'tcgdex';

  async searchByName(query: string, language = 'en', debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    const languageCode = toTcgdexLanguage(language);
    const url = `${env.TCGDEX_BASE_URL}/${languageCode}/cards?name=${encodeURIComponent(query)}`;
    try {
      const response = await requestJsonWithMeta<TcgdexCard[]>(
        url,
        {},
        { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 30 }
      );
      debugCollector?.push({
        source: this.source,
        searchType: 'name',
        query,
        endpoint: url,
        status: response.status,
        resultCount: response.data.length,
        topMatchName: response.data[0]?.name
      });
      const hydrated = await this.hydrateCards(response.data.slice(0, 8), languageCode);
      return hydrated.map((card) => this.normalize(card));
    } catch (error) {
      debugCollector?.push({
        source: this.source,
        searchType: 'name',
        query,
        endpoint: url,
        error: error instanceof Error ? error.message : 'Unknown adapter error',
        errorType: classifyProviderError(error)
      });
      throw error;
    }
  }

  async searchByNumber(cardNumber: string, setCode?: string, language = 'en', debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]> {
    if (!setCode) return [];
    const languageCode = toTcgdexLanguage(language);
    const normalizedSetCode = normalizeTcgdexSetCode(setCode);
    const localId = normalizePokemonCardNumberForApi(cardNumber) ?? cardNumber;
    const url = `${env.TCGDEX_BASE_URL}/${languageCode}/sets/${encodeURIComponent(normalizedSetCode)}/${encodeURIComponent(localId)}`;
    try {
      const response = await requestJsonWithMeta<TcgdexCard>(
        url,
        {},
        { cacheKey: `${this.source}:${url}`, ttlMs: 1000 * 60 * 60 }
      );
      debugCollector?.push({
        source: this.source,
        searchType: 'number',
        query: `${localId}${setCode ? ` ${setCode}` : ''}`,
        endpoint: url,
        status: response.status,
        resultCount: response.data ? 1 : 0,
        topMatchName: response.data?.name
      });
      return [this.normalize(response.data)];
    } catch (error) {
      debugCollector?.push({
        source: this.source,
        searchType: 'number',
        query: `${localId}${setCode ? ` ${setCode}` : ''}`,
        endpoint: url,
        error: error instanceof Error ? error.message : 'Unknown adapter error',
        errorType: classifyProviderError(error)
      });
      return [];
    }
  }

  async getCardById(id: string, language = 'en'): Promise<CardDetails | null> {
    const languageCode = toTcgdexLanguage(language);
    const card = await this.fetchRawCardById(id, languageCode);
    return card ? this.normalize(card) : null;
  }

  private async fetchRawCardById(id: string, language = 'en'): Promise<TcgdexCard | null> {
    const languageCode = toTcgdexLanguage(language);
    const url = `${env.TCGDEX_BASE_URL}/${languageCode}/cards/${encodeURIComponent(id)}`;
    try {
      return await requestJson<TcgdexCard>(
        url,
        {},
        { cacheKey: `${this.source}:card:${id}:${language}`, ttlMs: 1000 * 60 * 60 }
      );
    } catch {
      return null;
    }
  }

  private normalize(card: TcgdexCard): CardDetails {
    const officialTotal = card.set?.cardCount?.official;
    const displayNumber = card.localId && officialTotal ? `${card.localId}/${officialTotal}` : card.localId;
    return {
      id: card.id,
      source: this.source,
      game: this.game,
      name: card.name,
      setName: card.set?.name,
      setCode: card.set?.id,
      cardNumber: displayNumber,
      rarity: card.rarity,
      hp: card.hp !== undefined ? String(card.hp) : undefined,
      imageUrl: card.image,
      prices: extractTcgdexPrice(card.pricing)
    };
  }

  private async hydrateCards(cards: TcgdexCard[], language: string): Promise<TcgdexCard[]> {
    const hydrated = await Promise.all(
      cards.map(async (card) => {
        try {
          return await this.fetchRawCardById(card.id, language) ?? card;
        } catch {
          return card;
        }
      })
    );
    return hydrated;
  }
}

function normalizeTcgdexSetCode(setCode: string): string {
  const compact = setCode.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact.startsWith('svpen') || compact === 'svp') return 'svp';
  if (compact === 'baseset' || compact === 'base1') return 'base1';
  return compact || setCode.toLowerCase();
}

function toTcgdexLanguage(language?: string): string {
  const value = String(language ?? 'en').toLowerCase();
  if (value.includes('english') || value === 'en') return 'en';
  if (value.includes('french') || value === 'fr') return 'fr';
  if (value.includes('spanish') || value === 'es') return 'es';
  if (value.includes('german') || value === 'de') return 'de';
  if (value.includes('italian') || value === 'it') return 'it';
  if (value.includes('portuguese') || value === 'pt') return 'pt';
  return value || 'en';
}

function extractTcgdexPrice(pricing?: TcgdexCard['pricing']): CardCandidate['prices'] | undefined {
  const tcgplayer = pricing?.tcgplayer;
  const variantValues = tcgplayer
    ? Object.entries(tcgplayer)
        .flatMap(([variant, value]) => typeof value === 'object' && value
          ? [
              { field: `pricing.tcgplayer.${variant}.marketPrice`, value: value.marketPrice },
              { field: `pricing.tcgplayer.${variant}.midPrice`, value: value.midPrice },
              { field: `pricing.tcgplayer.${variant}.lowPrice`, value: value.lowPrice },
              { field: `pricing.tcgplayer.${variant}.highPrice`, value: value.highPrice }
            ]
          : [])
    : [];
  const tcgValue = variantValues.find((entry) => typeof entry.value === 'number' && Number.isFinite(entry.value));
  if (tcgValue?.value) {
    return {
      amount: tcgValue.value,
      market: tcgValue.value,
      currency: 'USD',
      source: 'tcgdex_tcgplayer',
      label: `$${tcgValue.value.toFixed(2)} ${tcgValue.field.includes('market') ? 'market' : 'estimate'}`
    };
  }

  const cardmarket = pricing?.cardmarket;
  const marketValue = cardmarket?.trend ?? cardmarket?.['trend-holo'] ?? cardmarket?.avg ?? cardmarket?.['avg-holo'] ?? cardmarket?.low ?? cardmarket?.['low-holo'];
  if (typeof marketValue === 'number' && Number.isFinite(marketValue)) {
    return {
      amount: marketValue,
      market: marketValue,
      currency: 'EUR',
      source: 'tcgdex_cardmarket',
      label: `€${marketValue.toFixed(2)} estimate`
    };
  }
  return undefined;
}
