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
  frontImageBuffer?: Buffer;
  cropValid?: boolean;
  cropMode?: 'auto' | 'fallback_center' | 'manual' | 'full_image';
};

type RegionBuffer = {
  region: OcrRegionName;
  buffer: Buffer;
};

type PokemonOcrAttempt = {
  name: string;
  cropWidth: number;
  cropHeight: number;
  regions: OcrRegionResult[];
  rawText: string;
  cleanedText: string;
  extracted: ExtractedCardDetails;
  usefulnessScore: number;
  averageConfidence: number;
  rejectedNameReason?: string;
};

export class OcrService {
  async readCard(
    buffer: Buffer,
    options: ReadCardOptions = {}
  ): Promise<{ regions: OcrRegionResult[]; ocrText: string; extracted: ExtractedCardDetails; debug: OcrDebugInfo }> {
    const game = normalizeGame(options.selectedGame);
    if (game === 'pokemon') {
      return this.readPokemonCard(buffer, options);
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
        regionTexts: Object.fromEntries(results.map((entry) => [entry.region, entry.text])),
        rawRegionTexts: Object.fromEntries(results.map((entry) => [entry.region, entry.text])),
        cleanedText: ocrText,
        extracted: this.extractGenericStructuredFields(results)
      }
    };
  }

  private async readPokemonCard(
    buffer: Buffer,
    options: ReadCardOptions = {}
  ): Promise<{ regions: OcrRegionResult[]; ocrText: string; extracted: ExtractedCardDetails; debug: OcrDebugInfo }> {
    const scanId = options.scanId;
    const attempts: PokemonOcrAttempt[] = [];
    const detectedMetadata = await sharp(buffer).metadata();
    let detectedAttempt: PokemonOcrAttempt | undefined;

    if (options.cropValid !== false) {
      detectedAttempt = await this.readPokemonAttempt('detected crop OCR', buffer, 'normalized-card');
      attempts.push(detectedAttempt);
      const crops = await this.extractPokemonRegionBuffers(await normalizeToPokemonCard(buffer));
      await this.saveDebugRegions(scanId, crops);
    }

    if (!detectedAttempt || detectedAttempt.usefulnessScore < 5 || options.cropMode === 'fallback_center') {
      const frontBuffer = options.frontImageBuffer ?? buffer;
      const fallbackAttempts = await Promise.all([
        this.readPokemonAttempt('full image OCR', frontBuffer, 'normalized-card'),
        this.centerCropPokemon(frontBuffer).then((center) => this.readPokemonAttempt('center crop OCR', center, 'normalized-card')),
        this.readFocusedPokemonAttempt('top region OCR', frontBuffer, ['name', 'hp']),
        this.readFocusedPokemonAttempt('bottom region OCR', frontBuffer, ['bottom']),
        this.readFocusedPokemonAttempt('attack/text region OCR', frontBuffer, ['attack'])
      ]);
      attempts.push(...fallbackAttempts);
    }

    const mergedAttempt = mergePokemonAttempts(attempts, detectedMetadata.width ?? 734, detectedMetadata.height ?? 1024);
    attempts.push(mergedAttempt);

    const best = attempts
      .sort((a, b) => b.usefulnessScore - a.usefulnessScore || b.averageConfidence - a.averageConfidence)[0];

    const results = best.regions;
    const regionTexts = Object.fromEntries(results.map((entry) => [entry.region, entry.text])) as Partial<Record<OcrRegionName, string>>;
    const rawRegionTexts = Object.fromEntries(results.map((entry) => [entry.region, entry.text])) as Partial<Record<OcrRegionName, string>>;
    const ocrText = best.rawText;
    const cleanedText = best.cleanedText;

    return {
      regions: results,
      ocrText,
      extracted: best.extracted,
      debug: {
        regionTexts,
        rawRegionTexts,
        cleanedText,
        extracted: best.extracted,
        attempts: attempts.map((attempt) => ({
          name: attempt.name,
          cropWidth: attempt.cropWidth,
          cropHeight: attempt.cropHeight,
          rawText: attempt.rawText,
          cleanedText: attempt.cleanedText,
          extracted: attempt.extracted,
          usefulnessScore: attempt.usefulnessScore,
          averageConfidence: attempt.averageConfidence,
          rejectedNameReason: attempt.rejectedNameReason
        })),
        selectedAttemptName: best.name,
        usefulnessScore: best.usefulnessScore,
        weakResultReason: best.usefulnessScore < 5 ? 'Not enough Pokemon card signals were found in OCR.' : undefined,
        rejectedCardNameReason: best.rejectedNameReason,
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

  private async readPokemonAttempt(name: string, buffer: Buffer, mode: 'normalized-card'): Promise<PokemonOcrAttempt> {
    const normalized = mode === 'normalized-card' ? await normalizeToPokemonCard(buffer) : buffer;
    const metadata = await sharp(buffer).metadata();
    const crops = await this.extractPokemonRegionBuffers(normalized);
    return this.readPokemonRegions(name, crops, metadata.width ?? 0, metadata.height ?? 0);
  }

  private async readFocusedPokemonAttempt(name: string, buffer: Buffer, regions: OcrRegionName[]): Promise<PokemonOcrAttempt> {
    const metadata = await sharp(buffer).metadata();
    const crops = await this.extractRawPokemonRegionBuffers(buffer, regions);
    return this.readPokemonRegions(name, crops, metadata.width ?? 0, metadata.height ?? 0);
  }

  private async readPokemonRegions(name: string, crops: RegionBuffer[], cropWidth: number, cropHeight: number): Promise<PokemonOcrAttempt> {
    const regionReads = await Promise.all(
      crops.map(async (region) => {
        try {
          const textResult = await withTimeout(
            this.readRegion(region.buffer),
            7000,
            `OCR timed out while reading the ${region.region} region.`
          );
          return {
            region: region.region,
            rawText: textResult.text.trim(),
            cleanedText: normalizeOcrText(textResult.text),
            confidence: textResult.confidence
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'OCR failed for this region.';
          return {
            region: region.region,
            rawText: `[OCR failed] ${message}`,
            cleanedText: '',
            confidence: 0
          };
        }
      })
    );

    const results: OcrRegionResult[] = regionReads.map((entry) => ({
      region: entry.region,
      text: entry.cleanedText,
      confidence: entry.confidence
    }));
    const regionTexts = Object.fromEntries(results.map((entry) => [entry.region, entry.text])) as Partial<Record<OcrRegionName, string>>;
    const rawText = regionReads.map((entry) => `[${entry.region}] ${entry.rawText}`).join('\n').trim();
    const cleanedText = results.map((entry) => `[${entry.region}] ${entry.text}`).join('\n').trim();
    const nameValidation = validatePokemonCardName(regionTexts.name, results.find((entry) => entry.region === 'name')?.confidence);
    const extracted = extractPokemonFields(regionTexts, nameValidation);
    const averageConfidence = results.length
      ? Math.round((results.reduce((sum, entry) => sum + entry.confidence, 0) / results.length) * 100) / 100
      : 0;

    return {
      name,
      cropWidth,
      cropHeight,
      regions: results,
      rawText,
      cleanedText,
      extracted,
      usefulnessScore: scorePokemonUsefulness(extracted, nameValidation.accepted, averageConfidence),
      averageConfidence,
      rejectedNameReason: nameValidation.accepted ? undefined : nameValidation.reason
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

  private async extractRawPokemonRegionBuffers(buffer: Buffer, regions: OcrRegionName[]): Promise<RegionBuffer[]> {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width ?? 734;
    const height = metadata.height ?? 1024;
    const regionMap: Partial<Record<OcrRegionName, [number, number, number, number]>> = {
      name: [0.04, 0.02, 0.64, 0.13],
      hp: [0.58, 0.02, 0.98, 0.13],
      attack: [0.06, 0.34, 0.94, 0.76],
      bottom: [0.02, 0.78, 0.98, 0.99]
    };

    return Promise.all(
      regions.map(async (region) => {
        const zone = regionMap[region] ?? [0, 0, 1, 1];
        return {
          region,
          buffer: await this.extractNormalizedRegion(image, width, height, zone[0], zone[1], zone[2], zone[3])
        };
      })
    );
  }

  private async centerCropPokemon(buffer: Buffer): Promise<Buffer> {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 734;
    const height = metadata.height ?? 1024;
    const targetAspect = 734 / 1024;
    const imageAspect = width / height;
    let cropWidth = width;
    let cropHeight = height;

    if (imageAspect > targetAspect) {
      cropWidth = Math.floor(height * targetAspect * 0.94);
      cropHeight = Math.floor(height * 0.94);
    } else {
      cropWidth = Math.floor(width * 0.94);
      cropHeight = Math.floor((width / targetAspect) * 0.94);
    }

    cropWidth = Math.min(width, Math.max(120, cropWidth));
    cropHeight = Math.min(height, Math.max(170, cropHeight));

    return sharp(buffer)
      .extract({
        left: Math.max(0, Math.floor((width - cropWidth) / 2)),
        top: Math.max(0, Math.floor((height - cropHeight) / 2)),
        width: cropWidth,
        height: cropHeight
      })
      .jpeg({ quality: 94 })
      .toBuffer();
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
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

function normalizeToPokemonCard(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: 734, height: 1024, fit: 'fill' })
    .jpeg({ quality: 95 })
    .toBuffer();
}

function validatePokemonCardName(raw?: string, confidence = 100): { accepted: boolean; cleanedName?: string; reason?: string } {
  const cleanedName = cleanPokemonName(raw);
  if (!cleanedName) {
    return { accepted: false, reason: 'No text was detected in the name region.' };
  }
  const letters = cleanedName.match(/[A-Za-z]/g)?.length ?? 0;
  const symbols = cleanedName.match(/[^A-Za-z0-9\s.'’:-]/g)?.length ?? 0;
  if (letters < 3) {
    return { accepted: false, reason: 'Detected name had fewer than three letters.' };
  }
  if (symbols > letters) {
    return { accepted: false, reason: 'Detected name was mostly symbols.' };
  }
  if (/[=«»<>~_{}[\]\\|]/.test(raw ?? '') && letters < 5) {
    return { accepted: false, reason: 'Detected name contained OCR symbol noise.' };
  }
  if (confidence < 18) {
    return { accepted: false, reason: 'Name OCR confidence was very low.' };
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

function cleanPokemonName(rawName = ''): string {
  let name = String(rawName)
    .replace(/\bBASIC\b/gi, '')
    .replace(/\bSTAGE\s?\d\b/gi, '')
    .replace(/\bHP\s?\d+\b/gi, '')
    .replace(/\bPOKEMON\b/gi, '')
    .replace(/^[^a-zA-Z]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const first = words[0];
    if (/^[0-9A-Z]{1,3}$/i.test(first)) {
      name = words.slice(1).join(' ');
    }
  }

  return name.trim();
}

function extractPokemonFields(
  regionTexts: Partial<Record<OcrRegionName, string>>,
  nameValidation = validatePokemonCardName(regionTexts.name)
): ExtractedCardDetails {
  const combined = [regionTexts.name, regionTexts.hp, regionTexts.attack, regionTexts.bottom].filter(Boolean).join('\n');
  return {
    name: nameValidation.accepted ? nameValidation.cleanedName : undefined,
    cardNumber: extractPokemonCardNumber(regionTexts.bottom ?? combined),
    setCode: extractPokemonSetCode(regionTexts.bottom ?? combined),
    language: detectLanguage(combined),
    rarity: extractRarity(regionTexts.bottom ?? combined),
    hp: extractPokemonHp(regionTexts.hp ?? regionTexts.name ?? combined),
    damage: extractPokemonDamage(regionTexts.attack ?? combined),
    year: extractPokemonCopyrightYear(regionTexts.bottom ?? combined),
    attackNameHint: extractPokemonAttackHint(regionTexts.attack ?? combined)
  };
}

function extractPokemonCardNumber(text: string): string | undefined {
  const source = String(text);
  const patterns = [
    /\b\d{1,3}\/\d{1,3}\b/i,
    /\b[A-Z]{1,3}\d{1,3}\/[A-Z]{1,3}\d{1,3}\b/i,
    /\bSVP\s?\d{1,3}\b/i,
    /\bTG\d{1,2}\/TG\d{1,2}\b/i,
    /\bGG\d{1,2}\/GG\d{1,2}\b/i,
    /\bSWSH\s?\d{1,3}\b/i,
    /\bSV\d{1,2}\s?\d{1,3}\b/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[0].replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

function extractPokemonSetCode(text: string): string | undefined {
  const svpMatch = text.match(/\b(SVP)\s*(EN)?\b/i);
  if (svpMatch) return [svpMatch[1], svpMatch[2]].filter(Boolean).join(' ').toUpperCase();
  return text.match(/\b(sv\d{0,2}|swsh\d+|xy\d{0,2}|sm\d{0,2}|bw\d{0,2})\b/i)?.[1]?.toUpperCase();
}

function extractRarity(text: string): string | undefined {
  return text.match(/\b(common|uncommon|rare|double rare|illustration rare|special illustration rare|ultra rare|hyper rare|promo|secret rare)\b/i)?.[1];
}

function extractPokemonHp(text: string): string | undefined {
  return text.match(/\bHP\s*(\d{2,3})\b/i)?.[1] ?? text.match(/\b(\d{2,3})\s*HP\b/i)?.[1];
}

function extractPokemonDamage(text: string): string | undefined {
  return text.match(/\b(10|20|30|40|50|60|70|80|90|100|110|120|130|140|150|160|170|180|190|200|210|220|230|240|250|260|270|280|290|300)\+?\b/)?.[1];
}

function extractPokemonCopyrightYear(text: string): string | undefined {
  return text.match(/\b(20\d{2}|19\d{2})\b/)?.[1];
}

function extractPokemonAttackHint(text: string): string | undefined {
  const attackWithDamage = normalizeOcrText(text).match(/\b([A-Z][A-Za-z' -]{2,20})\s+\d{2,3}\+?\b/);
  if (attackWithDamage?.[1] && !/\b(HP|SVP|ENERGY)\b/i.test(attackWithDamage[1])) {
    return attackWithDamage[1].trim();
  }
  const candidate = text
    .split(/\n|(?<=[a-z]) (?=[A-Z])|(?<=\d) (?=[A-Z])/)
    .map((line) => line.trim())
    .map((line) => line.replace(/\b\d{1,3}\+?\b/g, '').trim())
    .find((line) => line.length >= 3 && line.length <= 24 && /^[A-Za-z0-9' -]+$/.test(line) && !/\b(damage|opponent|pokemon|energy|weakness|resistance|apply|before|during|your|this|does|nothing|benched|fewer)\b/i.test(line));
  return candidate || undefined;
}

function scorePokemonUsefulness(extracted: ExtractedCardDetails, hasValidName: boolean, averageConfidence: number): number {
  let score = 0;
  if (hasValidName && extracted.name) score += 4;
  if (extracted.hp) score += 2;
  if (extracted.attackNameHint) score += 2;
  if (extracted.damage) score += 1;
  if (extracted.cardNumber) score += 3;
  if (extracted.setCode) score += 3;
  if (extracted.year) score += 1;
  if (extracted.language) score += 0.5;
  score += Math.min(1.5, Math.max(0, averageConfidence) / 100);
  return Math.round(score * 100) / 100;
}

function mergePokemonAttempts(attempts: PokemonOcrAttempt[], cropWidth: number, cropHeight: number): PokemonOcrAttempt {
  const pick = (field: keyof ExtractedCardDetails) =>
    attempts
      .filter((attempt) => Boolean(attempt.extracted[field]))
      .sort((a, b) => b.usefulnessScore - a.usefulnessScore || b.averageConfidence - a.averageConfidence)[0]?.extracted[field];
  const extracted: ExtractedCardDetails = {
    name: pick('name'),
    cardNumber: pick('cardNumber'),
    setCode: pick('setCode'),
    language: pick('language'),
    rarity: pick('rarity'),
    hp: pick('hp'),
    damage: pick('damage'),
    year: pick('year'),
    attackNameHint: pick('attackNameHint')
  };
  const regions = attempts.flatMap((attempt) => attempt.regions);
  const averageConfidence = regions.length
    ? Math.round((regions.reduce((sum, entry) => sum + entry.confidence, 0) / regions.length) * 100) / 100
    : 0;
  return {
    name: 'best composite OCR result',
    cropWidth,
    cropHeight,
    regions,
    rawText: attempts.map((attempt) => `## ${attempt.name}\n${attempt.rawText}`).join('\n\n'),
    cleanedText: attempts.map((attempt) => `## ${attempt.name}\n${attempt.cleanedText}`).join('\n\n'),
    extracted,
    usefulnessScore: scorePokemonUsefulness(extracted, Boolean(extracted.name), averageConfidence),
    averageConfidence
  };
}

function detectLanguage(text: string): string | undefined {
  if (/[ぁ-ゔァ-ヴー々〆〤]/.test(text)) return 'ja';
  if (/[éèêàç]/i.test(text)) return 'fr';
  if (/[äöüß]/i.test(text)) return 'de';
  if (/[ñ]/i.test(text)) return 'es';
  if (text.trim()) return 'en';
  return undefined;
}
