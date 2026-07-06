export type PokemonCardNumberEvidence = {
  localId?: string;
  printedNumber?: string;
  collectorNumber?: string;
  cardNumber?: string;
  setCode?: string;
  setName?: string;
  printedTotal?: string;
  rawCollectorText: string;
  candidates: string[];
};

export function normalizePokemonCollectorText(text = ''): string {
  return String(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/S\\\/P/gi, 'SVP')
    .replace(/\b5\s*V\s*P\b/gi, 'SVP')
    .replace(/\bS\s*Y\s*P\b/gi, 'SVP')
    .replace(/\bS\s*V\s*P\s*I\b/gi, 'SVP')
    .replace(/\bS\s*V\s*P\b/gi, 'SVP')
    .replace(/\bE\s*N\b/gi, 'EN')
    .replace(/\bSVPEN\b/gi, 'SVP EN')
    .replace(/\bSVP[-_\s]*EN\b/gi, 'SVP EN')
    .replace(/\bSVPl\b/gi, 'SVP')
    .replace(/\bSVPI\b/gi, 'SVP')
    .replace(/\[\s*SVP\s*\]/gi, 'SVP')
    .replace(/\bS\s*W\s*S\s*H\b/gi, 'SWSH')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePokemonCardNumberEvidence(text = ''): PokemonCardNumberEvidence {
  const source = normalizePokemonCollectorText(text);
  const candidates: string[] = [];

  const gallery = source.match(/\b(TG|GG)\s*0*(\d{1,2})\s*\/\s*(TG|GG)\s*0*(\d{1,2})\b/i);
  if (gallery) {
    const localId = `${gallery[1].toUpperCase()}${normalizeNumberToken(gallery[2])}`;
    const printedTotal = `${gallery[3].toUpperCase()}${normalizeNumberToken(gallery[4])}`;
    const printedNumber = `${localId}/${printedTotal}`;
    candidates.push(printedNumber);
    return {
      localId,
      printedNumber,
      collectorNumber: printedNumber,
      cardNumber: printedNumber,
      printedTotal,
      setCode: gallery[1].toUpperCase(),
      rawCollectorText: source,
      candidates
    };
  }

  const printed = source.match(/\b([A-Z]{0,3}0*\d{1,4})\s*\/\s*([A-Z]{0,3}0*\d{1,4})\b/i);
  if (printed) {
    const localId = normalizeNumberToken(printed[1]);
    const printedTotal = normalizeNumberToken(printed[2]);
    const printedNumber = `${localId}/${printedTotal}`;
    candidates.push(printedNumber);
    return {
      localId,
      printedNumber,
      collectorNumber: printedNumber,
      cardNumber: printedNumber,
      printedTotal,
      setCode: inferSetCodeFromPrintedTotal(printedTotal),
      setName: inferSetNameFromPrintedTotal(printedTotal),
      rawCollectorText: source,
      candidates
    };
  }

  const svp = source.match(/\bSVP\s*(?:EN)?\s*(\d{1,4})\b/i);
  if (svp) {
    const localId = normalizeNumberToken(svp[1]);
    if (isInvalidStandaloneCollectorNumber(localId)) {
      return {
        setCode: 'SVP EN',
        setName: 'SVP Black Star Promos',
        rawCollectorText: source,
        candidates
      };
    }
    candidates.push(localId);
    return {
      localId,
      collectorNumber: localId,
      cardNumber: localId,
      setCode: 'SVP EN',
      setName: 'SVP Black Star Promos',
      rawCollectorText: source,
      candidates
    };
  }

  const looseSvp = source.match(/\bSVP\b[\s\S]{0,80}?\b(?:EN\b)?[\s\S]{0,40}?\b[A-Z]?0*(\d{1,4})\b/i);
  if (looseSvp) {
    const localId = normalizeNumberToken(looseSvp[1]);
    if (!isInvalidStandaloneCollectorNumber(localId)) {
      candidates.push(localId);
      return {
        localId,
        collectorNumber: localId,
        cardNumber: localId,
        setCode: 'SVP EN',
        setName: 'SVP Black Star Promos',
        rawCollectorText: source,
        candidates
      };
    }
    return {
      setCode: 'SVP EN',
      setName: 'SVP Black Star Promos',
      rawCollectorText: source,
      candidates
    };
  }

  const swsh = source.match(/\bSWSH\s*0*(\d{1,4})\b/i);
  if (swsh) {
    const localId = `SWSH${normalizeNumberToken(swsh[1])}`;
    candidates.push(localId);
    return {
      localId,
      collectorNumber: localId,
      cardNumber: localId,
      setCode: 'SWSH',
      setName: 'SWSH Black Star Promos',
      rawCollectorText: source,
      candidates
    };
  }

  const modernSet = source.match(/\b(SV\d{1,2}|SM\d{1,2}|BW\d{1,2}|XY\d{1,2})\s*0*(\d{1,4})\b/i);
  if (modernSet) {
    const setCode = modernSet[1].toUpperCase();
    const localId = normalizeNumberToken(modernSet[2]);
    candidates.push(localId);
    return {
      localId,
      collectorNumber: localId,
      cardNumber: localId,
      setCode,
      rawCollectorText: source,
      candidates
    };
  }

  return {
    rawCollectorText: source,
    candidates
  };
}

export function extractPokemonHpValue(text = ''): string | undefined {
  const source = normalizePokemonCollectorText(text);
  return source.match(/\bHP\s*([1-3]?\d{2})\b/i)?.[1] ??
    source.match(/\b([1-3]?\d{2})\s*HP\b/i)?.[1] ??
    source.match(/\b([1-3]?\d{2})\s*H[PRY]{1,3}\b/i)?.[1];
}

export function normalizePokemonPrintedNumber(value?: string): string | undefined {
  const parsed = parsePokemonCardNumberEvidence(value);
  return parsed.printedNumber ?? parsed.collectorNumber ?? normalizeNumberToken(value);
}

export function normalizePokemonLocalId(value?: string): string | undefined {
  const parsed = parsePokemonCardNumberEvidence(value);
  if (parsed.localId) return parsed.localId;
  return normalizeNumberToken(String(value ?? '').split('/')[0]);
}

function normalizeNumberToken(value?: string): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^0+(?=\d)/, '');
}

function isInvalidStandaloneCollectorNumber(value?: string): boolean {
  const normalized = normalizeNumberToken(value);
  return normalized === '' || normalized === '0' || /^(19|20)\d{2}$/.test(normalized);
}

function inferSetCodeFromPrintedTotal(total?: string): string | undefined {
  if (total === '102') return 'Base Set';
  return undefined;
}

function inferSetNameFromPrintedTotal(total?: string): string | undefined {
  if (total === '102') return 'Base Set';
  return undefined;
}
