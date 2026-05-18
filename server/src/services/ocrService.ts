import path from 'node:path';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { env } from '../config/env.js';
import type { ExtractedCardDetails, OcrDebugInfo, OcrRegionName, OcrRegionResult, SupportedGame } from '../types/cards.js';
import { ensureDirectory } from '../utils/files.js';
import { withTimeout } from '../utils/async.js';

type ReadCardOptions = {
  scanId?: string;
  selectedGame?: string;
};

type RegionBuffer = {
  region: OcrRegionName;
  buffer: Buffer;
};

export class OcrService {
  async readCard(
    buffer: Buffer,
    options: ReadCardOptions = {}
  ): Promise<{ regions: OcrRegionResult[]; ocrText: string; extracted: ExtractedCardDetails; debug: OcrDebugInfo }> {
    const game = normalizeGame(options.selectedGame);
    if (game === 'pokemon') {
      return this.readPokemonCard(buffer, options.scanId);
    }

    const regions = await this.extractGenericRegionBuffers(buffer);
    const results = await Promise.all(
      regions.map(async (region) => {
        const textResult = await withTimeout(
          this.readRegion(region.buffer),
          9000,
          `OCR timed out while reading the ${region.region} region.`
        );
        return {
          region: region.region,
          text: textResult.text.trim(),
          confidence: textResult.confidence
        };
      })
    );

    const ocrText = results.map((entry) => `[${entry.region}] ${entry.text}`).join('\n').trim();
    return {
      regions: results,
      ocrText,
      extracted: this.extractGenericStructuredFields(results),
      debug: {
        regionTexts: Object.fromEntries(results.map((entry) => [entry.region, entry.text]))
      }
    };
  }

  private async readPokemonCard(
    buffer: Buffer,
    scanId?: string
  ): Promise<{ regions: OcrRegionResult[]; ocrText: string; extracted: ExtractedCardDetails; debug: OcrDebugInfo }> {
    const normalized = await sharp(buffer)
      .resize({ width: 734, height: 1024, fit: 'fill' })
      .jpeg({ quality: 95 })
      .toBuffer();

    const crops = await this.extractPokemonRegionBuffers(normalized);
    await this.saveDebugRegions(scanId, crops);

    const results = await Promise.all(
      crops.map(async (region) => {
        const textResult = await withTimeout(
          this.readRegion(region.buffer),
          9000,
          `OCR timed out while reading the ${region.region} region.`
        );
        return {
          region: region.region,
          text: normalizeOcrText(textResult.text),
          confidence: textResult.confidence
        };
      })
    );

    const regionTexts = Object.fromEntries(results.map((entry) => [entry.region, entry.text])) as Partial<Record<OcrRegionName, string>>;
    const nameValidation = validatePokemonCardName(regionTexts.name);

    const extracted: ExtractedCardDetails = {
      name: nameValidation.accepted ? nameValidation.cleanedName : undefined,
      cardNumber: extractPokemonCardNumber(regionTexts.bottom ?? ''),
      setCode: extractPokemonSetCode(regionTexts.bottom ?? ''),
      language: detectLanguage([regionTexts.name, regionTexts.bottom, regionTexts.attack].filter(Boolean).join('\n')),
      rarity: extractRarity(regionTexts.bottom ?? '')
    };

    const ocrText = results.map((entry) => `[${entry.region}] ${entry.text}`).join('\n').trim();

    return {
      regions: results,
      ocrText,
      extracted,
      debug: {
        regionTexts,
        rejectedCardNameReason: nameValidation.accepted ? undefined : nameValidation.reason,
        regionImages: scanId && env.OCR_DEBUG_MODE
          ? {
              name: `/debug-ocr/${scanId}/name_region.jpg`,
              attack: `/debug-ocr/${scanId}/attack_region.jpg`,
              bottom: `/debug-ocr/${scanId}/bottom_info_region.jpg`
            }
          : undefined
      }
    };
  }

  private async readRegion(buffer: Buffer): Promise<{ text: string; confidence: number }> {
    if (env.OCR_PROVIDER === 'paddle' || (env.OCR_PROVIDER === 'auto' && env.PADDLE_OCR_ENDPOINT)) {
      try {
        return await this.readWithPaddle(buffer);
      } catch {
        if (env.OCR_PROVIDER === 'paddle') throw new Error('PaddleOCR failed for the uploaded scan.');
      }
    }
    return this.readWithTesseract(buffer);
  }

  private async readWithPaddle(buffer: Buffer): Promise<{ text: string; confidence: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(env.PADDLE_OCR_ENDPOINT, {
      method: 'POST',
      headers: {
        ...(env.PADDLE_OCR_API_KEY ? { Authorization: `Bearer ${env.PADDLE_OCR_API_KEY}` } : {})
      },
      signal: controller.signal,
      body: (() => {
        const form = new FormData();
        form.append('image', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), 'card.jpg');
        return form;
      })()
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`PaddleOCR request failed with status ${response.status}`);
    }

    const data = (await response.json()) as { text?: string; confidence?: number };
    return {
      text: data.text ?? '',
      confidence: data.confidence ?? 0
    };
  }

  private async readWithTesseract(buffer: Buffer): Promise<{ text: string; confidence: number }> {
    const result = await withTimeout(
      Tesseract.recognize(buffer, 'eng'),
      9000,
      'OCR took too long to complete on this image.'
    );
    return {
      text: result.data.text ?? '',
      confidence: result.data.confidence ?? 0
    };
  }

  private async extractGenericRegionBuffers(buffer: Buffer): Promise<RegionBuffer[]> {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width ?? 900;
    const height = metadata.height ?? 1260;

    return Promise.all([
      { region: 'full' as const, buffer },
      {
        region: 'title' as const,
        buffer: await image.clone().extract({ left: 0, top: 0, width, height: Math.max(140, Math.floor(height * 0.22)) }).grayscale().normalize().toBuffer()
      },
      {
        region: 'footer' as const,
        buffer: await image.clone().extract({ left: 0, top: Math.floor(height * 0.72), width, height: Math.max(160, Math.floor(height * 0.28)) }).grayscale().normalize().toBuffer()
      },
      {
        region: 'number' as const,
        buffer: await image
          .clone()
          .extract({
            left: Math.floor(width * 0.55),
            top: Math.floor(height * 0.72),
            width: Math.max(140, Math.floor(width * 0.4)),
            height: Math.max(120, Math.floor(height * 0.18))
          })
          .grayscale()
          .normalize()
          .toBuffer()
      }
    ]);
  }

  private async extractPokemonRegionBuffers(normalized: Buffer): Promise<RegionBuffer[]> {
    const image = sharp(normalized);
    const width = 734;
    const height = 1024;
    return Promise.all([
      {
        region: 'name' as const,
        buffer: await this.extractNormalizedRegion(image, width, height, 0.06, 0.03, 0.62, 0.1)
      },
      {
        region: 'hp' as const,
        buffer: await this.extractNormalizedRegion(image, width, height, 0.6, 0.03, 0.96, 0.1)
      },
      {
        region: 'attack' as const,
        buffer: await this.extractNormalizedRegion(image, width, height, 0.08, 0.38, 0.92, 0.72)
      },
      {
        region: 'bottom' as const,
        buffer: await this.extractNormalizedRegion(image, width, height, 0.05, 0.88, 0.95, 0.98)
      }
    ]);
  }

  private async extractNormalizedRegion(
    image: sharp.Sharp,
    width: number,
    height: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): Promise<Buffer> {
    const left = Math.floor(width * x1);
    const top = Math.floor(height * y1);
    const cropWidth = Math.max(1, Math.floor(width * x2) - left);
    const cropHeight = Math.max(1, Math.floor(height * y2) - top);
    return image
      .clone()
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  }

  private async saveDebugRegions(scanId: string | undefined, regions: RegionBuffer[]): Promise<void> {
    if (!env.OCR_DEBUG_MODE || !scanId) return;
    const debugDir = path.join(env.OCR_DEBUG_DIR, scanId);
    await ensureDirectory(debugDir);

    const nameRegion = regions.find((region) => region.region === 'name');
    const attackRegion = regions.find((region) => region.region === 'attack');
    const bottomRegion = regions.find((region) => region.region === 'bottom');

    await Promise.all([
      nameRegion ? sharp(nameRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'name_region.jpg')) : Promise.resolve(),
      attackRegion ? sharp(attackRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'attack_region.jpg')) : Promise.resolve(),
      bottomRegion ? sharp(bottomRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'bottom_info_region.jpg')) : Promise.resolve()
    ]);
  }

  private extractGenericStructuredFields(results: OcrRegionResult[]): ExtractedCardDetails {
    const combined = results.map((entry) => entry.text).join('\n');
    const lines = combined
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const rarity = lines.find((line) => /\b(common|uncommon|rare|mythic|super rare|ultra rare|enchanted|legendary|secret rare)\b/i.test(line));
    const numberMatch =
      combined.match(/\b([A-Z]{1,4}[- ]?\d{1,4}[A-Z]?)\b/) ??
      combined.match(/\b(\d{1,3}\/\d{1,3})\b/) ??
      combined.match(/\b([A-Z]{2,5}\d{1,3})\b/);
    const setCodeMatch =
      combined.match(/\b(OP\d{2}|ST\d{2}|P-\d{3}|swsh\d+|sv\d+|[A-Z]{2,5}\d{0,2})\b/i) ??
      undefined;

    const titleCandidate = results
      .filter((entry) => entry.region === 'title' || entry.region === 'full')
      .flatMap((entry) => entry.text.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.length > 2 && !/\d/.test(line))
      .sort((a, b) => b.length - a.length)[0];

    return {
      name: titleCandidate,
      cardNumber: numberMatch?.[1],
      setCode: setCodeMatch?.[1],
      language: detectLanguage(combined),
      rarity: rarity?.trim()
    };
  }
}

function normalizeGame(value?: string): SupportedGame | undefined {
  const lowered = value?.toLowerCase();
  if (!lowered) return undefined;
  if (lowered.includes('pokemon')) return 'pokemon';
  if (lowered.includes('magic')) return 'magic';
  if (lowered.includes('yug')) return 'yugioh';
  if (lowered.includes('lorc')) return 'lorcana';
  if (lowered.includes('one')) return 'onepiece';
  return 'generic';
}

function normalizeOcrText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function validatePokemonCardName(raw?: string): { accepted: boolean; cleanedName?: string; reason?: string } {
  const cleanedName = normalizeOcrText(raw ?? '').replace(/^(basic|stage\s*\d)\s+/i, '').trim();
  if (!cleanedName) {
    return { accepted: false, reason: 'No text was detected in the name region.' };
  }
  const wordCount = cleanedName.split(' ').filter(Boolean).length;
  if (wordCount > 4) {
    return { accepted: false, reason: 'Detected name was longer than four words.' };
  }
  const banned = /\b(damage|opponent|active|pokemon|energy|attack|before|applying|weakness|resistance)\b/i;
  if (banned.test(cleanedName)) {
    return { accepted: false, reason: 'Detected name contained attack or effect text keywords.' };
  }
  return { accepted: true, cleanedName };
}

function extractPokemonCardNumber(text: string): string | undefined {
  return text.match(/\b([A-Z]{0,3}\d{1,3}\/\d{1,3}|[A-Z]{0,3}\d{1,3}|TG\d{1,2}|GG\d{1,2})\b/i)?.[1];
}

function extractPokemonSetCode(text: string): string | undefined {
  return text.match(/\b([a-z]{2,6}\d{0,2}|sv\d|swsh\d|xy|sm|bw)\b/i)?.[1];
}

function extractRarity(text: string): string | undefined {
  return text.match(/\b(common|uncommon|rare|double rare|illustration rare|special illustration rare|ultra rare|hyper rare|promo|secret rare)\b/i)?.[1];
}

function detectLanguage(text: string): string | undefined {
  if (/[ぁ-ゔァ-ヴー々〆〤]/.test(text)) return 'ja';
  if (/[éèêàç]/i.test(text)) return 'fr';
  if (/[äöüß]/i.test(text)) return 'de';
  if (/[ñ]/i.test(text)) return 'es';
  if (text.trim()) return 'en';
  return undefined;
}
