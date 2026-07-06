import type { ExtractedCardDetails, PublicCardMatch } from '../types/cards.js';

export type PokemonFallbackCard = {
  game: 'pokemon';
  name: string;
  normalizedName: string;
  cardNumber: string;
  setCode: string;
  normalizedSetCode: string;
  setSeries: string;
  setName: string;
  rarity: string;
  hp: string;
  year: string;
  tcgplayerProductId: string;
  tcgplayerProductName: string;
  externalPriceSearch: string;
  notes: string;
  estimatedValue?: NonNullable<PublicCardMatch['estimatedValue']>;
};

export const pokemonFallbackCards: PokemonFallbackCard[] = [
  {
    game: 'pokemon',
    name: 'Victini',
    normalizedName: 'victini',
    cardNumber: '208',
    setCode: 'SVP EN',
    normalizedSetCode: 'svp',
    setSeries: 'Scarlet & Violet Promo',
    setName: 'SV: Scarlet & Violet Promo Cards',
    rarity: 'Promo',
    hp: '80',
    year: '2025',
    tcgplayerProductId: '646169',
    tcgplayerProductName: 'Victini - 208',
    externalPriceSearch: 'Victini 208 SVP Scarlet Violet Promo',
    notes: 'Fallback entry because Pokemon TCG API may not return this exact promo card yet.',
    estimatedValue: {
      amount: undefined,
      min: 10,
      max: 20,
      currency: 'USD',
      label: '$10-$20 raw estimate',
      source: 'fallback_manual_market_estimate',
      confidence: 'manual_estimate',
      note: 'Exact Pokemon TCG API price unavailable. Estimate based on external market references for Victini 208.'
    }
  }
];

export function findPokemonFallbackCard(extracted: ExtractedCardDetails | Record<string, unknown>): PokemonFallbackCard | undefined {
  const name = normalizeName(String((extracted as ExtractedCardDetails).name ?? ''));
  const cardNumber = normalizeCardNumber(String((extracted as ExtractedCardDetails).cardNumber ?? ''));
  const setCode = normalizeSetCode(String((extracted as ExtractedCardDetails).setCode ?? ''));

  return pokemonFallbackCards.find((card) => {
    const nameMatches = Boolean(name && (card.normalizedName === name || card.normalizedName.includes(name) || name.includes(card.normalizedName)));
    const numberMatches = Boolean(cardNumber && normalizeCardNumber(card.cardNumber) === cardNumber);
    const setMatches = Boolean(!setCode || card.normalizedSetCode === setCode);
    return nameMatches && numberMatches && setMatches;
  });
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeCardNumber(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/]+/g, '');
}

function normalizeSetCode(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact.startsWith('svpen') || compact === 'svp') return 'svp';
  if (compact.startsWith('swsh')) return 'swsh';
  return compact;
}
