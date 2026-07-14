import { env } from '../config/env.js';

export type PaddleOcrPoint = [number, number];

export type PaddleOcrRegion = {
  text: string;
  confidence: number;
  box: [PaddleOcrPoint, PaddleOcrPoint, PaddleOcrPoint, PaddleOcrPoint];
};

export type PaddleOcrResult = {
  provider: 'paddleocr';
  processingMs: number;
  image: { width: number; height: number };
  regions: PaddleOcrRegion[];
};

export class PaddleOcrError extends Error {
  constructor(readonly code: 'DISABLED' | 'NOT_CONFIGURED' | 'TIMEOUT' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'OCR_FAILED', message: string) {
    super(message);
    this.name = 'PaddleOcrError';
  }
}

export class PaddleOcrProvider {
  isEnabled(): boolean {
    return env.PADDLE_OCR_ENABLED;
  }

  async health(): Promise<{ enabled: boolean; reachable: boolean }> {
    if (!this.isEnabled() || !env.PADDLE_OCR_ENDPOINT) return { enabled: this.isEnabled(), reachable: false };
    try {
      const response = await fetch(new URL('/health', env.PADDLE_OCR_ENDPOINT), {
        headers: env.PADDLE_OCR_API_KEY ? { Authorization: `Bearer ${env.PADDLE_OCR_API_KEY}` } : {},
        signal: AbortSignal.timeout(Math.min(env.PADDLE_OCR_TIMEOUT_MS, 3000))
      });
      return { enabled: true, reachable: response.ok };
    } catch {
      return { enabled: true, reachable: false };
    }
  }

  async recognize(buffer: Buffer, input: { scanId?: string; language?: string } = {}): Promise<PaddleOcrResult> {
    if (!this.isEnabled()) throw new PaddleOcrError('DISABLED', 'PaddleOCR is disabled.');
    if (!env.PADDLE_OCR_ENDPOINT) throw new PaddleOcrError('NOT_CONFIGURED', 'PaddleOCR endpoint is not configured.');

    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), 'card.jpg');
    if (input.language) form.append('language', input.language);
    if (input.scanId) form.append('scanId', input.scanId);

    let response: Response;
    try {
      response = await fetch(new URL('/ocr', env.PADDLE_OCR_ENDPOINT), {
        method: 'POST',
        headers: env.PADDLE_OCR_API_KEY ? { Authorization: `Bearer ${env.PADDLE_OCR_API_KEY}` } : {},
        body: form,
        signal: AbortSignal.timeout(env.PADDLE_OCR_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new PaddleOcrError(timedOut ? 'TIMEOUT' : 'UNAVAILABLE', timedOut ? 'PaddleOCR request timed out.' : 'PaddleOCR service is unavailable.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PaddleOcrError('INVALID_RESPONSE', 'PaddleOCR returned invalid JSON.');
    }
    if (!response.ok) throw new PaddleOcrError('UNAVAILABLE', `PaddleOCR returned HTTP ${response.status}.`);
    if (!isPaddleResponse(payload) || !payload.success) {
      throw new PaddleOcrError('OCR_FAILED', 'PaddleOCR could not extract usable text.');
    }

    return {
      provider: 'paddleocr',
      processingMs: payload.processingMs,
      image: payload.image,
      regions: payload.regions.filter((region) => region.confidence >= 0.25 && region.text.trim().length > 0)
    };
  }
}

type PaddleResponse = PaddleOcrResult & { success: boolean };

function isPaddleResponse(value: unknown): value is PaddleResponse {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PaddleResponse>;
  return typeof item.success === 'boolean' &&
    typeof item.processingMs === 'number' &&
    Boolean(item.image && typeof item.image.width === 'number' && typeof item.image.height === 'number') &&
    Array.isArray(item.regions) &&
    item.regions.every((region) => Boolean(region && typeof region.text === 'string' && typeof region.confidence === 'number' && Array.isArray(region.box)));
}
