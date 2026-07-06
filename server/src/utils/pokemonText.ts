const KNOWN_POKEMON_NAMES = [
  'Alakazam',
  'Blastoise',
  'Chansey',
  'Charizard',
  'Clefairy',
  'Gyarados',
  'Hitmonchan',
  'Machamp',
  'Magneton',
  'Mew',
  'Mewtwo',
  'Nidoking',
  'Ninetales',
  'Pikachu',
  'Poliwrath',
  'Raichu',
  'Venusaur',
  'Victini',
  'Zapdos'
];

export function normalizeKnownPokemonName(rawName?: string): string | undefined {
  const normalizedRaw = compactPokemonText(rawName);
  if (!normalizedRaw) return undefined;

  const direct = KNOWN_POKEMON_NAMES.find((name) => normalizedRaw.includes(compactPokemonText(name)));
  if (direct) return direct;

  const tokens = String(rawName ?? '')
    .split(/[^A-Za-z]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);

  let best: { name: string; distance: number } | undefined;
  for (const token of tokens) {
    const compactToken = compactPokemonText(token);
    for (const name of KNOWN_POKEMON_NAMES) {
      const distance = levenshtein(compactToken, compactPokemonText(name));
      if (distance <= 2 && (!best || distance < best.distance)) {
        best = { name, distance };
      }
    }
  }

  return best?.name;
}

export function normalizePokemonCardNumberForApi(value?: string): string | undefined {
  const cleaned = normalizePokemonCardNumber(value);
  if (!cleaned) return undefined;
  const fraction = cleaned.match(/^0*(\d{1,3})\/0*\d{1,3}$/);
  if (fraction) return fraction[1];
  return cleaned.replace(/^0+(?=\d)/, '');
}

export function pokemonCardNumbersMatch(left?: string, right?: string): boolean {
  const leftClean = normalizePokemonCardNumber(left);
  const rightClean = normalizePokemonCardNumber(right);
  if (!leftClean || !rightClean) return false;
  if (leftClean === rightClean) return true;
  return normalizePokemonCardNumberForApi(leftClean) === normalizePokemonCardNumberForApi(rightClean);
}

export function normalizePokemonCardNumber(value?: string): string | undefined {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9/]+/g, '');
  return cleaned || undefined;
}

function compactPokemonText(value?: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z]+/g, '');
}

function levenshtein(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, (_, row) => Array<number>(b.length + 1).fill(row));
  for (let col = 0; col <= b.length; col += 1) matrix[0][col] = col;

  for (let row = 1; row <= a.length; row += 1) {
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}
