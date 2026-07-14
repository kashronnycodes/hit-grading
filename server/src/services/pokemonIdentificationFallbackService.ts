import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { ScrydexVisionProvider, type ScrydexVisionResult } from '../providers/scrydexVisionProvider.js';
import type { CardCandidate } from '../types/cards.js';
import { globalCache } from '../utils/cache.js';

type Logger = (message: string) => void;

export type PokemonIdentificationFallbackInput = {
  frontImage: Buffer;
  topMatch?: CardCandidate;
  alternatives: CardCandidate[];
  numberConflict: boolean;
  canSearch: boolean;
  paddleFailureReason?: string | null;
  log?: Logger;
};

export type PokemonIdentificationFallbackResult = {
  identificationProvider: 'paddleocr' | 'scrydex' | 'manual';
  fallbackReason: string | null;
  topMatch?: CardCandidate;
  alternatives: CardCandidate[];
};

export class PokemonIdentificationFallbackService {
  constructor(private readonly scrydexVisionProvider = new ScrydexVisionProvider()) {}

  async resolve(input: PokemonIdentificationFallbackInput): Promise<PokemonIdentificationFallbackResult> {
    if (isReliablePaddleMatch(input.topMatch, input.alternatives, input.numberConflict)) {
      return { identificationProvider: 'paddleocr', fallbackReason: null, topMatch: input.topMatch, alternatives: input.alternatives };
    }

    const fallbackReason = input.paddleFailureReason ?? getPaddleFallbackReason(input);
    input.log?.(`Scrydex fallback reason: ${fallbackReason}`);
    const readiness = this.scrydexVisionProvider.canCall();
    if (!readiness.ok) {
      input.log?.(`Scrydex Vision skipped: ${readiness.reason}`);
      return { identificationProvider: 'manual', fallbackReason, topMatch: input.topMatch, alternatives: input.alternatives };
    }

    const hash = createHash('sha256').update(input.frontImage).digest('hex');
    const cacheKey = `vision-identification:${hash}`;
    let vision = globalCache.get<ScrydexVisionResult>(cacheKey);
    if (vision) {
      input.log?.('Scrydex Vision cache hit');
    } else {
      input.log?.('Scrydex Vision called');
      try {
        vision = await this.scrydexVisionProvider.identify(input.frontImage);
        globalCache.set(cacheKey, vision, 1000 * 60 * 60 * 24);
      } catch (error) {
        input.log?.(`Scrydex Vision failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    if (!vision?.matches.length) {
      return { identificationProvider: 'manual', fallbackReason, topMatch: input.topMatch, alternatives: input.alternatives };
    }
    return {
      identificationProvider: 'scrydex',
      fallbackReason,
      topMatch: vision.matches[0],
      alternatives: vision.matches.slice(1, 6)
    };
  }
}

export function isReliablePaddleMatch(topMatch: CardCandidate | undefined, alternatives: CardCandidate[], numberConflict: boolean): boolean {
  if (!topMatch || numberConflict || (topMatch.confidence ?? 0) < env.PADDLE_OCR_MATCH_THRESHOLD) return false;
  const runnerUp = alternatives[0]?.confidence ?? 0;
  return runnerUp === 0 || (topMatch.confidence ?? 0) - runnerUp >= 0.08;
}

function getPaddleFallbackReason(input: PokemonIdentificationFallbackInput): string {
  if (!input.canSearch) return 'insufficient_ocr_evidence';
  if (!input.topMatch) return 'no_database_match';
  if (input.numberConflict) return 'collector_number_conflict';
  if ((input.topMatch.confidence ?? 0) < env.PADDLE_OCR_MATCH_THRESHOLD) return 'match_below_threshold';
  if (input.alternatives[0] && (input.topMatch.confidence ?? 0) - (input.alternatives[0].confidence ?? 0) < 0.08) return 'ambiguous_matches';
  return 'unreliable_match';
}
