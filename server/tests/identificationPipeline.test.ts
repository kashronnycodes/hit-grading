import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { env } from '../src/config/env.js';
import type { PaddleOcrResult } from '../src/providers/paddleOcrProvider.js';
import type { ScrydexVisionResult } from '../src/providers/scrydexVisionProvider.js';
import { getDetectionHttpStatus } from '../src/routes/cards.js';
import { OcrService } from '../src/services/ocrService.js';
import { CardPricingService } from '../src/services/cardPricingService.js';
import { ImagePreprocessService } from '../src/services/imagePreprocessService.js';
import { PokemonIdentificationFallbackService } from '../src/services/pokemonIdentificationFallbackService.js';
import type { CardCandidate } from '../src/types/cards.js';

const strongMatch: CardCandidate = {
  id: 'tcgdex:en:test-219', source: 'local-cache', game: 'pokemon', name: 'Pikachu ex',
  cardNumber: '219/191', setCode: 'test', confidence: 0.93, confidenceReasons: ['exact number and name']
};

function paddleResult(lines: Array<{ text: string; confidence: number; x: number; y: number }>): PaddleOcrResult {
  return {
    provider: 'paddleocr', processingMs: 25, image: { width: 734, height: 1024 },
    regions: lines.map(({ text, confidence, x, y }) => ({
      text, confidence,
      box: [[x, y], [x + 180, y], [x + 180, y + 30], [x, y + 30]]
    }))
  };
}

test('Tesseract is disabled by default and PaddleOCR is called once', async () => {
  let calls = 0;
  const paddle = { recognize: async () => { calls += 1; return paddleResult([{ text: 'Pikachu ex', confidence: 0.96, x: 50, y: 45 }]); } };
  await new OcrService(paddle as never).readCard(Buffer.from('front'), { selectedGame: 'pokemon' });
  assert.equal(env.TESSERACT_OCR_ENABLED, false);
  assert.equal(calls, 1);
});

test('PaddleOCR parses an exact collector number', async () => {
  const paddle = { recognize: async () => paddleResult([
    { text: 'Pikachu ex', confidence: 0.96, x: 50, y: 45 },
    { text: '219/191', confidence: 0.94, x: 430, y: 930 }
  ]) };
  const result = await new OcrService(paddle as never).readCard(Buffer.from('front-collector'), { selectedGame: 'pokemon' });
  assert.equal(result.extracted.cardNumber, '219/191');
});

test('PaddleOCR parses name plus number evidence', async () => {
  const paddle = { recognize: async () => paddleResult([
    { text: 'Pikachu ex', confidence: 0.97, x: 50, y: 45 },
    { text: '004/102', confidence: 0.91, x: 30, y: 940 }
  ]) };
  const result = await new OcrService(paddle as never).readCard(Buffer.from('front-name-number'), { selectedGame: 'pokemon' });
  assert.equal(result.extracted.name, 'Pikachu ex');
  assert.equal(result.extracted.cardNumber, '4/102');
});

function fallbackHarness(result: ScrydexVisionResult = { provider: 'scrydex', matches: [strongMatch] }, callable = true) {
  let calls = 0;
  let received: Buffer | undefined;
  const provider = {
    canCall: () => callable ? { ok: true } : { ok: false, reason: 'fallback_disabled' },
    identify: async (front: Buffer) => { calls += 1; received = front; return result; }
  };
  return { service: new PokemonIdentificationFallbackService(provider as never), calls: () => calls, received: () => received };
}

test('strong PaddleOCR match skips Scrydex', async () => {
  const harness = fallbackHarness();
  const result = await harness.service.resolve({ frontImage: Buffer.from('strong'), topMatch: strongMatch, alternatives: [], numberConflict: false, canSearch: true });
  assert.equal(result.identificationProvider, 'paddleocr');
  assert.equal(harness.calls(), 0);
});

for (const reason of ['paddleocr_timeout', 'paddleocr_unavailable', 'no_database_match']) {
  test(`${reason} triggers one Scrydex fallback`, async () => {
    const harness = fallbackHarness();
    const result = await harness.service.resolve({ frontImage: Buffer.from(reason), alternatives: [], numberConflict: false, canSearch: reason !== 'no_database_match', paddleFailureReason: reason });
    assert.equal(result.identificationProvider, 'scrydex');
    assert.equal(harness.calls(), 1);
  });
}

test('Scrydex is never called twice for a duplicate image hash', async () => {
  const harness = fallbackHarness();
  const input = { frontImage: Buffer.from('duplicate-image'), alternatives: [], numberConflict: false, canSearch: false };
  await harness.service.resolve(input);
  await harness.service.resolve(input);
  assert.equal(harness.calls(), 1);
});

test('disabled Scrydex fallback returns manual without a call', async () => {
  const harness = fallbackHarness({ provider: 'scrydex', matches: [] }, false);
  const result = await harness.service.resolve({ frontImage: Buffer.from('disabled'), alternatives: [], numberConflict: false, canSearch: false });
  assert.equal(result.identificationProvider, 'manual');
  assert.equal(harness.calls(), 0);
});

test('Scrydex with no match returns controlled manual identification', async () => {
  const harness = fallbackHarness({ provider: 'scrydex', matches: [] });
  const result = await harness.service.resolve({ frontImage: Buffer.from('no-vision-match'), alternatives: [], numberConflict: false, canSearch: true });
  assert.equal(result.identificationProvider, 'manual');
  assert.equal(harness.calls(), 1);
});

test('only the supplied front image is sent to Scrydex Vision', async () => {
  const harness = fallbackHarness();
  const front = Buffer.from('front-only');
  await harness.service.resolve({ frontImage: front, alternatives: [], numberConflict: false, canSearch: false });
  assert.equal(harness.received(), front);
});

test('normal unidentified Pokemon response maps to HTTP 422 while non-Pokemon remains unchanged', () => {
  assert.equal(getDetectionHttpStatus({ identificationProvider: 'manual' }, 'pokemon'), 422);
  assert.equal(getDetectionHttpStatus({ identificationProvider: 'manual' }, 'magic'), 200);
});

test('pricing provider is not called before confirmation', async () => {
  let calls = 0;
  const provider = {
    canCall: () => ({ ok: true }),
    getCardPricing: async () => { calls += 1; throw new Error('must not run'); }
  };
  const result = await new CardPricingService(provider as never).priceCard({
    officialMatch: { id: 'test', source: 'local-cache', game: 'pokemon', cardName: 'Pikachu' },
    detectedDetails: { cardName: 'Pikachu' }
  });
  assert.equal(result.scrydexCalled, false);
  assert.equal(calls, 0);
});

test('a tiny false contour is never selected as the OCR crop', async () => {
  const scanId = `test-tiny-${Date.now()}`;
  const image = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#f7f7f7' } })
    .composite([{ input: { create: { width: 16, height: 14, channels: 3, background: '#111111' } }, left: 100, top: 100 }])
    .jpeg()
    .toBuffer();
  const result = await new ImagePreprocessService().preprocess(scanId, image);
  assert.notEqual(result.diagnostics.ocrInput?.source, 'auto');
  assert.ok((result.diagnostics.ocrInput?.width ?? 0) > 80);
  assert.ok((result.diagnostics.ocrInput?.height ?? 0) > 80);
  await Promise.all([
    fs.unlink(result.rawImagePath).catch(() => undefined),
    fs.unlink(result.normalizedImagePath).catch(() => undefined)
  ]);
});
