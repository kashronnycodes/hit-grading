import { env } from '../config/env.js';
import type { CardCandidate } from '../types/cards.js';
import sharp from 'sharp';

export type ScrydexVisionResult = { matches: CardCandidate[]; provider: 'scrydex' };

export class ScrydexVisionProvider {
  canCall(): { ok: boolean; reason?: string } {
    if (!env.SCRYDEX_VISION_FALLBACK_ENABLED) return { ok: false, reason: 'fallback_disabled' };
    if (!env.SCRYDEX_API_KEY || !env.SCRYDEX_TEAM_ID) return { ok: false, reason: 'missing_credentials' };
    return { ok: true };
  }

  async identify(frontImage: Buffer): Promise<ScrydexVisionResult> {
    const readiness = this.canCall();
    if (!readiness.ok) throw new Error(readiness.reason);

    const optimizedFront = await sharp(frontImage)
      .rotate()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(optimizedFront)], { type: 'image/jpeg' }), 'card.jpg');
    form.append('games', 'pokemon');
    const response = await fetch(`${env.SCRYDEX_API_BASE_URL}/vision/v1/cards/identify`, {
      method: 'POST',
      headers: { 'X-Api-Key': env.SCRYDEX_API_KEY, 'X-Team-ID': env.SCRYDEX_TEAM_ID },
      body: form,
      signal: AbortSignal.timeout(env.SCRYDEX_VISION_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Scrydex Vision returned HTTP ${response.status}.`);
    const payload = await response.json() as ScrydexVisionResponse;
    const matches = (payload.data?.matches ?? []).filter((match) => match.score >= env.SCRYDEX_VISION_MATCH_THRESHOLD).slice(0, 6).flatMap((match) => {
      if (!match.card?.id || !match.card.name) return [];
      return [{
        id: match.card.id,
        source: 'scrydex-vision',
        game: 'pokemon',
        name: match.card.name,
        cardNumber: match.card.number ?? match.card.printed_number,
        setCode: match.card.expansion?.id,
        setName: match.card.expansion?.name,
        language: payload.data?.analysis?.language_code,
        rarity: match.card.rarity,
        imageUrl: match.card.images?.find((image) => image.type === 'front')?.large,
        confidence: Math.max(0, Math.min(0.99, match.score)),
        confidenceReasons: [`Scrydex Vision score ${match.score}`]
      } satisfies CardCandidate];
    });
    return { provider: 'scrydex', matches };
  }
}

type ScrydexVisionResponse = {
  data?: {
    analysis?: { language_code?: string };
    matches?: Array<{
      score: number;
      card?: {
        id?: string;
        name?: string;
        number?: string;
        printed_number?: string;
        rarity?: string;
        expansion?: { id?: string; name?: string };
        images?: Array<{ type?: string; large?: string }>;
      };
    }>;
  };
};
