import path from 'node:path';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { env } from '../config/env.js';
import type {
  CollectorNumberCandidate,
  CollectorOcrQualityInfo,
  ExtractedCardDetails,
  OcrDebugInfo,
  OcrCropDebugInfo,
  OcrEvidenceAttemptDebugInfo,
  OcrRegionName,
  OcrRegionResult,
  SupportedGame
} from '../types/cards.js';
import { ensureDirectory } from '../utils/files.js';
import { withTimeout } from '../utils/async.js';
import { normalizeKnownPokemonName } from '../utils/pokemonText.js';
import {
  extractPokemonHpValue,
  normalizePokemonCollectorText,
  parsePokemonCardNumberEvidence
} from '../utils/pokemonCardNumberParser.js';

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
  crop?: Omit<OcrCropDebugInfo, 'attemptName' | 'region'>;
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
  evidenceAttempts?: OcrEvidenceAttemptDebugInfo[];
  selectedEvidence?: Partial<Record<PokemonEvidenceRegionName, string>>;
  cropReports?: OcrCropDebugInfo[];
  collectorQuality?: CollectorOcrQualityInfo[];
};

type PokemonEvidenceRegionName = 'hp' | 'bottom' | 'collector' | 'collectorRight' | 'collectorClassic' | 'collectorPromo' | 'collectorFused';

type PokemonRegionRead = {
  region: OcrRegionName;
  rawText: string;
  cleanedText: string;
  confidence: number;
  evidenceAttempts?: OcrEvidenceAttemptDebugInfo[];
  selectedEvidenceReason?: string;
  collectorQuality?: CollectorOcrQualityInfo;
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
      detectedAttempt = await this.readPokemonAttempt('detected crop OCR', buffer, 'normalized-card', scanId);
      attempts.push(detectedAttempt);
      const normalizedForDebug = await normalizeToPokemonCard(buffer);
      const crops = await this.extractPokemonRegionBuffers(normalizedForDebug);
      await this.saveDebugCard(scanId, normalizedForDebug);
      await this.saveDebugRegions(scanId, crops);
    } else {
      const normalizedForDebug = await normalizeToPokemonCard(buffer);
      const crops = await this.extractPokemonRegionBuffers(normalizedForDebug);
      attempts.push(await this.readPokemonAttempt('preprocessed fallback crop OCR', buffer, 'normalized-card', scanId));
      await this.saveDebugCard(scanId, normalizedForDebug);
      await this.saveDebugRegions(scanId, crops);
    }

    if (!detectedAttempt || detectedAttempt.usefulnessScore < 5 || options.cropMode === 'fallback_center') {
      const frontBuffer = options.frontImageBuffer ?? buffer;
      const fallbackAttempts = await Promise.all([
        this.readPokemonAttempt('full image OCR', frontBuffer, 'normalized-card', scanId),
        this.centerCropPokemon(frontBuffer, 0.78).then((center) => this.readPokemonAttempt('fallback centered crop OCR', center, 'normalized-card', scanId)),
        this.centerCropPokemon(frontBuffer, 0.88).then((center) => this.readPokemonAttempt('larger centered crop OCR', center, 'normalized-card', scanId)),
        this.readFocusedPokemonAttempt('top region OCR', frontBuffer, ['name', 'hp'], scanId),
        this.readFocusedPokemonAttempt('bottom region OCR', frontBuffer, ['bottom', 'collector', 'collectorRight', 'collectorClassic', 'collectorPromo'], scanId),
        this.readFocusedPokemonAttempt('attack/text region OCR', frontBuffer, ['attack', 'attackDamage'], scanId)
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
  const collectorNumberCandidates = buildCollectorNumberCandidates(attempts);
  const chosenCollectorNumber = best.extracted.cardNumber ?? collectorNumberCandidates[0]?.value ?? null;
  const collectorNumberConfidence = getCollectorNumberConfidence(collectorNumberCandidates, chosenCollectorNumber);
  const chosenCandidate = collectorNumberCandidates.find((candidate) => normalizeCardNumberForVote(candidate.value) === normalizeCardNumberForVote(chosenCollectorNumber ?? ''));

    return {
      regions: results,
      ocrText,
      extracted: {
        ...best.extracted,
        cardNumber: best.extracted.cardNumber ?? collectorNumberCandidates[0]?.value,
        collectorNumber: best.extracted.collectorNumber ?? chosenCandidate?.value,
        localId: best.extracted.localId ?? chosenCandidate?.localId,
        printedNumber: best.extracted.printedNumber ?? chosenCandidate?.printedNumber,
        printedTotal: best.extracted.printedTotal ?? chosenCandidate?.printedTotal,
        setCode: best.extracted.setCode ?? chosenCandidate?.setCode,
        setName: best.extracted.setName ?? chosenCandidate?.setName
      },
      debug: {
        regionTexts,
        rawRegionTexts,
        cleanedText,
        extracted: {
          ...best.extracted,
          cardNumber: best.extracted.cardNumber ?? collectorNumberCandidates[0]?.value,
          collectorNumber: best.extracted.collectorNumber ?? chosenCandidate?.value,
          localId: best.extracted.localId ?? chosenCandidate?.localId,
          printedNumber: best.extracted.printedNumber ?? chosenCandidate?.printedNumber,
          printedTotal: best.extracted.printedTotal ?? chosenCandidate?.printedTotal,
          setCode: best.extracted.setCode ?? chosenCandidate?.setCode,
          setName: best.extracted.setName ?? chosenCandidate?.setName
        },
        attempts: attempts.map((attempt) => ({
          name: attempt.name,
          cropWidth: attempt.cropWidth,
          cropHeight: attempt.cropHeight,
          rawText: attempt.rawText,
          cleanedText: attempt.cleanedText,
          extracted: attempt.extracted,
          usefulnessScore: attempt.usefulnessScore,
          averageConfidence: attempt.averageConfidence,
          rejectedNameReason: attempt.rejectedNameReason,
          evidenceAttempts: attempt.evidenceAttempts,
          selectedEvidence: attempt.selectedEvidence,
          cropReports: attempt.cropReports,
          collectorQuality: attempt.collectorQuality
        })),
        selectedAttemptName: best.name,
        usefulnessScore: best.usefulnessScore,
        weakResultReason: best.usefulnessScore < 5 ? 'Not enough Pokemon card signals were found in OCR.' : undefined,
        rejectedCardNameReason: best.rejectedNameReason,
        collectorNumberCandidates,
        chosenCollectorNumber,
        collectorNumberConfidence,
        cropReports: attempts.flatMap((attempt) => attempt.cropReports ?? []),
        collectorQuality: attempts.flatMap((attempt) => attempt.collectorQuality ?? []),
        regionImages: scanId && env.OCR_DEBUG_MODE
          ? {
              name: `/debug-ocr/${scanId}/name_region.jpg`,
              hp: `/debug-ocr/${scanId}/hp_region.jpg`,
              attack: `/debug-ocr/${scanId}/attack_region.jpg`,
              attackDamage: `/debug-ocr/${scanId}/attack_damage_region.jpg`,
              bottom: `/debug-ocr/${scanId}/bottom_info_region.jpg`,
              collector: `/debug-ocr/${scanId}/collector_number_region.jpg`,
              collectorRight: `/debug-ocr/${scanId}/collector_number_right_region.jpg`,
              collectorClassic: `/debug-ocr/${scanId}/collector_classic_number_region.jpg`,
              collectorPromo: `/debug-ocr/${scanId}/collector_promo_code_region.jpg`,
              fullCard: `/debug-ocr/${scanId}/perspective_corrected_card.jpg`
            }
          : undefined
      }
    };
  }

  private async readPokemonAttempt(name: string, buffer: Buffer, mode: 'normalized-card', scanId?: string): Promise<PokemonOcrAttempt> {
    const normalized = mode === 'normalized-card' ? await normalizeToPokemonCard(buffer) : buffer;
    const metadata = await sharp(buffer).metadata();
    const crops = await this.extractPokemonRegionBuffers(normalized);
    return this.readPokemonRegions(name, crops, metadata.width ?? 0, metadata.height ?? 0, scanId);
  }

  private async readFocusedPokemonAttempt(name: string, buffer: Buffer, regions: OcrRegionName[], scanId?: string): Promise<PokemonOcrAttempt> {
    const metadata = await sharp(buffer).metadata();
    const crops = await this.extractRawPokemonRegionBuffers(buffer, regions);
    return this.readPokemonRegions(name, crops, metadata.width ?? 0, metadata.height ?? 0, scanId);
  }

  private async readPokemonRegions(name: string, crops: RegionBuffer[], cropWidth: number, cropHeight: number, scanId?: string): Promise<PokemonOcrAttempt> {
    const regionReads = await Promise.all(crops.map((region) => this.readPokemonRegion(name, region, scanId)));
    const fusedRead = fusePokemonCollectorEvidence(regionReads);
    if (fusedRead) {
      regionReads.push(fusedRead);
    }

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
    const evidenceAttempts = regionReads.flatMap((entry) => entry.evidenceAttempts ?? []);
    const collectorQuality = regionReads.flatMap((entry) => entry.collectorQuality ? [entry.collectorQuality] : []);
    const cropReports = crops
      .filter((crop) => crop.crop)
      .map((crop) => ({
        attemptName: name,
        region: crop.region,
        ...crop.crop
      }));
    const selectedEvidence = Object.fromEntries(
      regionReads
        .filter((entry) => entry.selectedEvidenceReason)
        .map((entry) => [entry.region, entry.selectedEvidenceReason])
    ) as PokemonOcrAttempt['selectedEvidence'];
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
      usefulnessScore: scorePokemonUsefulness(extracted, nameValidation.accepted, averageConfidence) + scorePokemonTextQuality(cleanedText),
      averageConfidence,
      rejectedNameReason: nameValidation.accepted ? undefined : nameValidation.reason,
      evidenceAttempts: evidenceAttempts.length ? evidenceAttempts : undefined,
      selectedEvidence: Object.keys(selectedEvidence ?? {}).length ? selectedEvidence : undefined,
      cropReports: cropReports.length ? cropReports : undefined,
      collectorQuality: collectorQuality.length ? collectorQuality : undefined
    };
  }

  private async readPokemonRegion(attemptName: string, region: RegionBuffer, scanId?: string): Promise<PokemonRegionRead> {
    if (shouldUsePokemonEvidenceVariants(attemptName, region.region)) {
      return this.readPokemonEvidenceRegion(region, attemptName, scanId);
    }

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
  }

  private async readPokemonEvidenceRegion(region: RegionBuffer, attemptName: string, scanId?: string): Promise<PokemonRegionRead> {
    const evidenceRegion = region.region as PokemonEvidenceRegionName;
    const variants = await this.buildPokemonEvidenceVariants(region.buffer, region.region);
    const attempts: OcrEvidenceAttemptDebugInfo[] = [];

    for (const variant of variants) {
      const imagePath = await this.saveEvidenceVariant(scanId, attemptName, region.region, variant.name, variant.buffer);
      try {
        const textResult = await withTimeout(
          this.readRegion(variant.buffer),
          7000,
          `OCR timed out while reading the ${region.region} ${variant.name} variant.`
        );
        const cleanedText = normalizeOcrText(textResult.text);
        attempts.push({
          ...scorePokemonEvidenceText(evidenceRegion, variant.name, textResult.text.trim(), cleanedText, textResult.confidence),
          imagePath
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'OCR failed for this variant.';
        attempts.push({
          ...scorePokemonEvidenceText(evidenceRegion, variant.name, `[OCR failed] ${message}`, '', 0),
          imagePath
        });
      }

      if (shouldUseCollectorConfiguredOcr(evidenceRegion)) {
        const collectorVariantName = `${variant.name}:collector-config`;
        try {
          const textResult = await withTimeout(
            this.readCollectorRegion(variant.buffer, evidenceRegion),
            5000,
            `Collector OCR timed out while reading the ${region.region} ${variant.name} variant.`
          );
          const cleanedText = normalizeOcrText(textResult.text);
          attempts.push({
            ...scorePokemonEvidenceText(evidenceRegion, collectorVariantName, textResult.text.trim(), cleanedText, textResult.confidence),
            imagePath
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Collector OCR failed for this variant.';
          attempts.push({
            ...scorePokemonEvidenceText(evidenceRegion, collectorVariantName, `[OCR failed] ${message}`, '', 0),
            imagePath
          });
        }
      }
    }

    const selected = attempts
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || b.cleanedText.length - a.cleanedText.length)[0];
    for (const attempt of attempts) {
      attempt.selected = attempt === selected;
    }
    const collectorQuality = isCollectorQualityRegion(evidenceRegion)
      ? await analyzeCollectorOcrQuality(region.buffer, attemptName, evidenceRegion, selected)
      : undefined;

    return {
      region: region.region,
      rawText: selected?.rawText ?? '',
      cleanedText: selected?.cleanedText ?? '',
      confidence: selected?.confidence ?? 0,
      evidenceAttempts: attempts,
      selectedEvidenceReason: selected
        ? `${selected.variant}: ${selected.reason}`
        : undefined,
      collectorQuality
    };
  }

  private async buildPokemonEvidenceVariants(
    buffer: Buffer,
    region: OcrRegionName
  ): Promise<Array<{ name: string; buffer: Buffer }>> {
    const variants: Array<{ name: string; buffer: Buffer }> = [{ name: 'original', buffer }];

    const isHp = region === 'hp';
    const isCollector = isCollectorOcrRegion(region);
    const upscale = isHp ? 2 : 3;
    variants.push({
      name: `contrast-upscale-${upscale}x`,
      buffer: await sharp(buffer)
        .resize({ width: Math.max(1, Math.floor((await sharp(buffer).metadata()).width ?? 1) * upscale) })
        .grayscale()
        .normalize()
        .linear(isHp ? 1.25 : 1.45, isHp ? -10 : -18)
        .sharpen({ sigma: isHp ? 0.9 : 1.15 })
        .png()
        .toBuffer()
    });

    if (!isHp) {
      const metadata = await sharp(buffer).metadata();
      variants.push({
        name: 'threshold-upscale-4x',
        buffer: await sharp(buffer)
          .resize({ width: Math.max(1, Math.floor((metadata.width ?? 1) * 4)) })
          .grayscale()
          .normalize()
          .linear(1.6, -24)
          .sharpen({ sigma: 1.2 })
          .threshold(150)
          .png()
          .toBuffer()
      });
    }

    if (isCollector) {
      const metadata = await sharp(buffer).metadata();
      const width = Math.max(1, Math.floor((metadata.width ?? 1) * 4));
      variants.push({
        name: 'collector-soft-upscale-4x',
        buffer: await sharp(buffer)
          .resize({ width })
          .grayscale()
          .normalize()
          .sharpen({ sigma: 0.75 })
          .png()
          .toBuffer()
      });
      variants.push({
        name: 'collector-inverted-threshold-4x',
        buffer: await sharp(buffer)
          .resize({ width })
          .grayscale()
          .normalize()
          .linear(1.45, -16)
          .sharpen({ sigma: 0.9 })
          .threshold(145)
          .negate()
          .png()
          .toBuffer()
      });
    }

    return variants;
  }

  private async saveEvidenceVariant(
    scanId: string | undefined,
    attemptName: string,
    region: OcrRegionName,
    variantName: string,
    buffer: Buffer
  ): Promise<string | undefined> {
    if (!env.OCR_DEBUG_MODE || !scanId) return undefined;
    const debugDir = path.join(env.OCR_DEBUG_DIR, scanId, 'variants');
    await ensureDirectory(debugDir);
    const fileName = `${slugForFile(attemptName)}_${slugForFile(region)}_${slugForFile(variantName)}.jpg`;
    await sharp(buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, fileName));
    return `/debug-ocr/${scanId}/variants/${fileName}`;
  }

  private async withCropDebug(
    region: OcrRegionName,
    buffer: Buffer,
    sourceWidth: number,
    sourceHeight: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): Promise<RegionBuffer> {
    const metadata = await sharp(buffer).metadata();
    const left = Math.floor(sourceWidth * x1);
    const top = Math.floor(sourceHeight * y1);
    const cropWidth = Math.max(1, Math.floor(sourceWidth * x2) - left);
    const cropHeight = Math.max(1, Math.floor(sourceHeight * y2) - top);
    return {
      region,
      buffer,
      crop: {
        percent: {
          x1: roundPercent(x1),
          y1: roundPercent(y1),
          x2: roundPercent(x2),
          y2: roundPercent(y2)
        },
        pixels: {
          left,
          top,
          width: cropWidth,
          height: cropHeight
        },
        dimensions: {
          width: metadata.width ?? cropWidth,
          height: metadata.height ?? cropHeight
        }
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

  private async readCollectorRegion(buffer: Buffer, region: PokemonEvidenceRegionName): Promise<{ text: string; confidence: number }> {
    const isClassic = region === 'collectorClassic' || region === 'collectorRight';
    const result = await Tesseract.recognize(buffer, 'eng', {
      tessedit_pageseg_mode: isClassic ? Tesseract.PSM.SINGLE_LINE : Tesseract.PSM.SPARSE_TEXT,
      tessedit_char_whitelist: isClassic ? '0123456789/' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    } as Partial<Tesseract.WorkerOptions>);
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
      this.withCropDebug('name', await this.extractNormalizedRegion(image, width, height, 0.06, 0.03, 0.62, 0.1), width, height, 0.06, 0.03, 0.62, 0.1),
      this.withCropDebug('hp', await this.extractNormalizedRegion(image, width, height, 0.6, 0.03, 0.96, 0.1), width, height, 0.6, 0.03, 0.96, 0.1),
      this.withCropDebug('attack', await this.extractNormalizedRegion(image, width, height, 0.08, 0.38, 0.92, 0.72), width, height, 0.08, 0.38, 0.92, 0.72),
      this.withCropDebug('attackDamage', await this.extractDamageRegion(image, width, height), width, height, 0.68, 0.36, 0.96, 0.72),
      this.withCropDebug('bottom', await this.extractNormalizedRegion(image, width, height, 0.05, 0.88, 0.95, 0.98), width, height, 0.05, 0.88, 0.95, 0.98),
      this.withCropDebug('collector', await this.extractCollectorRegion(image, width, height), width, height, 0, 0.78, 0.45, 0.98),
      this.withCropDebug('collectorRight', await this.extractCollectorRightRegion(image, width, height), width, height, 0.68, 0.86, 0.98, 0.99),
      this.withCropDebug('collectorClassic', await this.extractCollectorClassicRegion(image, width, height), width, height, 0.86, 0.955, 0.998, 0.998),
      this.withCropDebug('collectorPromo', await this.extractCollectorPromoRegion(image, width, height), width, height, 0.02, 0.87, 0.36, 0.985)
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
      attackDamage: [0.68, 0.34, 0.96, 0.76],
      bottom: [0.02, 0.78, 0.98, 0.99],
      collector: [0, 0.78, 0.45, 0.98],
      collectorRight: [0.68, 0.86, 1, 0.99],
      collectorClassic: [0.86, 0.955, 0.998, 0.998],
      collectorPromo: [0.02, 0.87, 0.36, 0.985]
    };

    return Promise.all(
      regions.map(async (region) => {
        const zone = regionMap[region] ?? [0, 0, 1, 1];
        return this.withCropDebug(region, await this.extractNormalizedRegion(image, width, height, zone[0], zone[1], zone[2], zone[3]), width, height, zone[0], zone[1], zone[2], zone[3]);
      })
    );
  }

  private async centerCropPokemon(buffer: Buffer, heightScale = 0.78): Promise<Buffer> {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 734;
    const height = metadata.height ?? 1024;
    const targetAspect = 734 / 1024;
    let cropHeight = Math.floor(height * heightScale);
    let cropWidth = Math.floor(cropHeight * targetAspect);

    if (cropWidth > width * 0.95) {
      cropWidth = Math.floor(width * 0.92);
      cropHeight = Math.floor(cropWidth / targetAspect);
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

  private async extractCollectorRegion(image: sharp.Sharp, width: number, height: number): Promise<Buffer> {
    const left = 0;
    const top = Math.floor(height * 0.78);
    const cropWidth = Math.max(1, Math.floor(width * 0.45));
    const cropHeight = Math.max(1, Math.floor(height * 0.98) - top);
    return image
      .clone()
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize({ width: cropWidth * 4, height: cropHeight * 4, fit: 'fill' })
      .grayscale()
      .normalize()
      .linear(1.35, -18)
      .sharpen({ sigma: 1.1 })
      .png()
      .toBuffer();
  }

  private async extractCollectorRightRegion(image: sharp.Sharp, width: number, height: number): Promise<Buffer> {
    const left = Math.floor(width * 0.68);
    const top = Math.floor(height * 0.86);
    const cropWidth = Math.max(1, Math.floor(width * 0.98) - left);
    const cropHeight = Math.max(1, Math.floor(height * 0.99) - top);
    return image
      .clone()
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize({ width: cropWidth * 4, height: cropHeight * 4, fit: 'fill' })
      .grayscale()
      .normalize()
      .linear(1.45, -20)
      .sharpen({ sigma: 1.15 })
      .png()
      .toBuffer();
  }

  private async extractCollectorClassicRegion(image: sharp.Sharp, width: number, height: number): Promise<Buffer> {
    return extractPokemonMicroRegion(image, width, height, 0.86, 0.955, 0.998, 0.998, 8, 1.55, -18);
  }

  private async extractCollectorPromoRegion(image: sharp.Sharp, width: number, height: number): Promise<Buffer> {
    return extractPokemonMicroRegion(image, width, height, 0.02, 0.87, 0.36, 0.985, 6, 1.45, -18);
  }

  private async extractDamageRegion(image: sharp.Sharp, width: number, height: number): Promise<Buffer> {
    const left = Math.floor(width * 0.68);
    const top = Math.floor(height * 0.36);
    const cropWidth = Math.max(1, Math.floor(width * 0.96) - left);
    const cropHeight = Math.max(1, Math.floor(height * 0.72) - top);
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
    const hpRegion = regions.find((region) => region.region === 'hp');
    const attackRegion = regions.find((region) => region.region === 'attack');
    const attackDamageRegion = regions.find((region) => region.region === 'attackDamage');
    const bottomRegion = regions.find((region) => region.region === 'bottom');
    const collectorRegion = regions.find((region) => region.region === 'collector');
    const collectorRightRegion = regions.find((region) => region.region === 'collectorRight');
    const collectorClassicRegion = regions.find((region) => region.region === 'collectorClassic');
    const collectorPromoRegion = regions.find((region) => region.region === 'collectorPromo');

    await Promise.all([
      nameRegion ? sharp(nameRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'name_region.jpg')) : Promise.resolve(),
      hpRegion ? sharp(hpRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'hp_region.jpg')) : Promise.resolve(),
      attackRegion ? sharp(attackRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'attack_region.jpg')) : Promise.resolve(),
      attackDamageRegion ? sharp(attackDamageRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'attack_damage_region.jpg')) : Promise.resolve(),
      bottomRegion ? sharp(bottomRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'bottom_info_region.jpg')) : Promise.resolve(),
      collectorRegion ? sharp(collectorRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'collector_number_region.jpg')) : Promise.resolve(),
      collectorRightRegion ? sharp(collectorRightRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'collector_number_right_region.jpg')) : Promise.resolve(),
      collectorClassicRegion ? sharp(collectorClassicRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'collector_classic_number_region.jpg')) : Promise.resolve(),
      collectorPromoRegion ? sharp(collectorPromoRegion.buffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'collector_promo_code_region.jpg')) : Promise.resolve()
    ]);
  }

  private async saveDebugCard(scanId: string | undefined, normalized: Buffer): Promise<void> {
    if (!env.OCR_DEBUG_MODE || !scanId) return;
    const debugDir = path.join(env.OCR_DEBUG_DIR, scanId);
    await ensureDirectory(debugDir);
    await sharp(normalized).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'perspective_corrected_card.jpg'));
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

function fusePokemonCollectorEvidence(regionReads: PokemonRegionRead[]): PokemonRegionRead | undefined {
  const bottomReads = regionReads.filter((entry) => isCollectorCandidateRegion(entry.region));
  if (!bottomReads.length) return undefined;

  const evidenceAttempts = bottomReads.flatMap((entry) => entry.evidenceAttempts ?? []);
  const evidenceTexts = [
    ...bottomReads.flatMap((entry) => [entry.cleanedText, entry.rawText]),
    ...evidenceAttempts.flatMap((attempt) => [attempt.cleanedText, attempt.rawText])
  ]
    .map((text) => normalizeOcrText(text))
    .filter(Boolean);

  const directText = evidenceTexts.join(' ');
  const directParsed = parsePokemonCardNumberEvidence(directText);
  const fusedText = directParsed.cardNumber
    ? directParsed.rawCollectorText
    : buildFusedPokemonCollectorText(evidenceTexts);

  if (!fusedText) return undefined;

  const averageConfidence = evidenceAttempts.length
    ? Math.round((evidenceAttempts.reduce((sum, attempt) => sum + attempt.confidence, 0) / evidenceAttempts.length) * 100) / 100
    : Math.round((bottomReads.reduce((sum, entry) => sum + entry.confidence, 0) / bottomReads.length) * 100) / 100;

  const fusedAttempt = scorePokemonEvidenceText('collectorFused', 'fusion-across-bottom-regions', fusedText, fusedText, averageConfidence);
  if (!fusedAttempt.parsedLocalId && !fusedAttempt.parsedPrintedNumber && !fusedAttempt.parsedCollectorNumber && !fusedAttempt.parsedSetCode) {
    return undefined;
  }

  fusedAttempt.score += 3;
  fusedAttempt.reason = `${fusedAttempt.reason}, fused evidence across bottom OCR regions`;

  return {
    region: 'collectorFused',
    rawText: fusedText,
    cleanedText: fusedText,
    confidence: averageConfidence,
    evidenceAttempts: [fusedAttempt],
    selectedEvidenceReason: `fusion-across-bottom-regions: ${fusedAttempt.reason}`,
    collectorQuality: buildFusedCollectorQuality(fusedAttempt, averageConfidence)
  };
}

function buildFusedCollectorQuality(
  selected: OcrEvidenceAttemptDebugInfo,
  confidence: number
): CollectorOcrQualityInfo {
  const hasNumber = Boolean(selected.parsedPrintedNumber || selected.parsedCollectorNumber || selected.parsedLocalId);
  return {
    attemptName: 'fused bottom collector evidence',
    roi: 'collectorFused',
    width: 0,
    height: 0,
    blurScore: 0,
    glareRatio: 0,
    contrastScore: 0,
    edgeDensityScore: 0,
    selectedEvidence: `${selected.variant}: ${selected.reason}`,
    readable: hasNumber,
    recaptureRecommended: !hasNumber,
    reason: hasNumber
      ? `Fused bottom OCR evidence produced usable collector data at OCR confidence ${Math.round(confidence)}.`
      : 'Fused bottom OCR evidence did not produce a collector number.'
  };
}

function buildFusedPokemonCollectorText(texts: string[]): string | undefined {
  const normalizedText = normalizePokemonCollectorText(texts.join(' '));
  const printedNumber = normalizedText.match(/\b[A-Z]{0,3}0*\d{1,4}\s*\/\s*[A-Z]{0,3}0*\d{1,4}\b/i)?.[0];
  if (printedNumber) return printedNumber;

  const setCode = inferPokemonSetCodeFromEvidence(normalizedText);
  const localId = setCode ? extractLikelyLocalIdFromEvidence(normalizedText) : undefined;
  if (setCode && localId) {
    return `${setCode} ${localId}`;
  }
  if (setCode) return setCode;
  return undefined;
}

function inferPokemonSetCodeFromEvidence(text: string): string | undefined {
  if (/\bSVP\b/i.test(text)) return /\bEN\b/i.test(text) ? 'SVP EN' : 'SVP';
  if (/\bSWSH\b/i.test(text)) return 'SWSH';
  const gallery = text.match(/\b(TG|GG)\b/i)?.[1];
  if (gallery) return gallery.toUpperCase();
  return text.match(/\b(SV\d{1,2}|SM\d{1,2}|BW\d{1,2}|XY\d{1,2})\b/i)?.[1]?.toUpperCase();
}

function extractLikelyLocalIdFromEvidence(text: string): string | undefined {
  const counts = new Map<string, number>();
  const source = normalizePokemonCollectorText(text);
  const preferredMatches = source.matchAll(/\b(?:SVP|SWSH|TG|GG|EN)?\s*[A-Z]?\s*0*(\d{1,4})\b/gi);
  for (const match of preferredMatches) {
    const value = normalizeCardNumberForVote(match[1]);
    if (isBogusCollectorNumberValue(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([value]) => Number(value) >= 10 && Number(value) < 1000)
    .sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0]?.[0];
}

function isPokemonEvidenceRegion(region: OcrRegionName): region is PokemonEvidenceRegionName {
  return region === 'hp' ||
    region === 'bottom' ||
    region === 'collector' ||
    region === 'collectorRight' ||
    region === 'collectorClassic' ||
    region === 'collectorPromo' ||
    region === 'collectorFused';
}

function shouldUsePokemonEvidenceVariants(attemptName: string, region: OcrRegionName): region is PokemonEvidenceRegionName {
  if (!isPokemonEvidenceRegion(region)) return false;
  if (region === 'collectorFused') return false;
  if (attemptName === 'detected crop OCR') return true;
  if (attemptName === 'bottom region OCR' && isPokemonBottomEvidenceRegion(region)) return true;
  if (attemptName === 'top region OCR' && region === 'hp') return true;
  return false;
}

function isPokemonBottomEvidenceRegion(region: PokemonEvidenceRegionName): boolean {
  return region === 'bottom' ||
    region === 'collector' ||
    region === 'collectorRight' ||
    region === 'collectorClassic' ||
    region === 'collectorPromo';
}

function isCollectorOcrRegion(region: OcrRegionName): boolean {
  return region === 'collector' ||
    region === 'collectorRight' ||
    region === 'collectorClassic' ||
    region === 'collectorPromo';
}

function isCollectorQualityRegion(region: PokemonEvidenceRegionName): region is CollectorOcrQualityInfo['roi'] {
  return region === 'collector' ||
    region === 'collectorRight' ||
    region === 'collectorClassic' ||
    region === 'collectorPromo' ||
    region === 'collectorFused';
}

function shouldUseCollectorConfiguredOcr(region: PokemonEvidenceRegionName): boolean {
  return region === 'collectorClassic' ||
    region === 'collectorPromo' ||
    region === 'collectorRight';
}

async function analyzeCollectorOcrQuality(
  buffer: Buffer,
  attemptName: string,
  roi: CollectorOcrQualityInfo['roi'],
  selected?: OcrEvidenceAttemptDebugInfo
): Promise<CollectorOcrQualityInfo> {
  const { data, info } = await sharp(buffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const total = Math.max(1, width * height);
  let sum = 0;
  let bright = 0;
  let dark = 0;

  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    sum += value;
    if (value >= 245) bright += 1;
    if (value <= 12) dark += 1;
  }

  const mean = sum / total;
  let variance = 0;
  for (let i = 0; i < data.length; i += 1) {
    const delta = data[i] - mean;
    variance += delta * delta;
  }
  const contrastScore = Math.round(Math.sqrt(variance / total) * 100) / 100;
  const glareRatio = Math.round((bright / total) * 10000) / 10000;
  const shadowRatio = Math.round((dark / total) * 10000) / 10000;

  const step = Math.max(1, Math.floor(Math.max(width, height) / 360));
  let laplacianSum = 0;
  let laplacianCount = 0;
  let edgeCount = 0;
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const center = data[y * width + x];
      const laplacian = Math.abs(
        (4 * center) -
        data[y * width + (x - step)] -
        data[y * width + (x + step)] -
        data[(y - step) * width + x] -
        data[(y + step) * width + x]
      );
      const gradient = Math.abs(center - data[y * width + (x - step)]) + Math.abs(center - data[(y - step) * width + x]);
      laplacianSum += laplacian;
      laplacianCount += 1;
      if (gradient > 42) edgeCount += 1;
    }
  }
  const blurScore = Math.round((laplacianSum / Math.max(1, laplacianCount)) * 100) / 100;
  const edgeDensityScore = Math.round((edgeCount / Math.max(1, laplacianCount)) * 10000) / 10000;

  const hasParsedEvidence = Boolean(selected?.parsedPrintedNumber || selected?.parsedCollectorNumber || selected?.parsedLocalId || selected?.parsedSetCode);
  const hasNumberEvidence = Boolean(selected?.parsedPrintedNumber || selected?.parsedCollectorNumber || selected?.parsedLocalId);
  const reasons: string[] = [];
  if (width < 140 || height < 42) reasons.push('collector crop is very small');
  if (blurScore < 15) reasons.push('collector text appears blurry or smeared');
  if (glareRatio > 0.08) reasons.push('collector crop has strong highlight clipping/glare');
  if (shadowRatio > 0.35) reasons.push('collector crop is heavily shadowed or thresholded');
  if (contrastScore < 22) reasons.push('collector crop has low contrast');
  if (edgeDensityScore < 0.015) reasons.push('collector crop has weak text-edge detail');
  if (!hasParsedEvidence) reasons.push('OCR did not produce structured collector evidence');

  const qualityLooksReadable = width >= 140 &&
    height >= 42 &&
    blurScore >= 15 &&
    contrastScore >= 22 &&
    glareRatio <= 0.16 &&
    edgeDensityScore >= 0.015;
  const readable = hasNumberEvidence || (qualityLooksReadable && hasParsedEvidence);
  const recaptureRecommended = !readable && (reasons.length > 0 || roi === 'collectorClassic' || roi === 'collectorPromo');

  return {
    attemptName,
    roi,
    width,
    height,
    blurScore,
    glareRatio,
    contrastScore,
    edgeDensityScore,
    selectedEvidence: selected ? `${selected.variant}: ${selected.reason}` : undefined,
    readable,
    recaptureRecommended,
    reason: readable
      ? `Collector ROI produced usable evidence${hasNumberEvidence ? ' including a number.' : '.'}`
      : reasons.join('; ') || 'Collector ROI did not produce readable OCR evidence.'
  };
}

function scorePokemonEvidenceText(
  region: PokemonEvidenceRegionName,
  variant: string,
  rawText: string,
  cleanedText: string,
  confidence: number
): OcrEvidenceAttemptDebugInfo {
  const parsed = parsePokemonCardNumberEvidence(cleanedText);
  const parsedHp = extractPokemonHpValue(cleanedText);
  const normalized = normalizePokemonCollectorText(cleanedText);
  const reasons: string[] = [];
  let score = 0;

  if (parsed.printedNumber) {
    score += 10;
    reasons.push(`printed number ${parsed.printedNumber}`);
  }
  if (parsed.localId) {
    score += 5;
    reasons.push(`localId ${parsed.localId}`);
  }
  if (parsed.collectorNumber && parsed.collectorNumber !== parsed.printedNumber) {
    score += 5;
    reasons.push(`collector number ${parsed.collectorNumber}`);
  }
  if (parsed.setCode) {
    score += 4;
    reasons.push(`set code ${parsed.setCode}`);
  }
  if (parsed.setName) {
    score += 2;
    reasons.push(`set clue ${parsed.setName}`);
  }
  if (parsedHp) {
    score += region === 'hp' ? 8 : 2;
    reasons.push(`HP ${parsedHp}`);
  }
  if (/\b(SVP|SWSH|TG|GG|SV\d{1,2}|SM\d{1,2}|XY\d{1,2}|BW\d{1,2})\b/i.test(normalized)) {
    score += 2;
    reasons.push('Pokemon set-style text');
  }

  const alphanumericCount = cleanedText.match(/[A-Za-z0-9]/g)?.length ?? 0;
  const symbolCount = cleanedText.match(/[^A-Za-z0-9\s/.-]/g)?.length ?? 0;
  if (alphanumericCount > 0) {
    score += Math.min(3, Math.max(0, confidence) / 28);
  }
  if (symbolCount > alphanumericCount && !parsed.printedNumber && !parsed.localId) {
    score -= 2;
    reasons.push('mostly OCR symbol noise');
  }
  if (!cleanedText.trim()) {
    score -= 1;
    reasons.push('empty OCR text');
  }

  return {
    region,
    variant,
    rawText,
    cleanedText,
    confidence,
    score: Math.round(score * 100) / 100,
    reason: reasons.length ? reasons.join(', ') : 'no structured Pokemon evidence',
    parsedLocalId: parsed.localId,
    parsedPrintedNumber: parsed.printedNumber,
    parsedCollectorNumber: parsed.collectorNumber,
    parsedSetCode: parsed.setCode,
    parsedSetName: parsed.setName,
    parsedHp
  };
}

function normalizeOcrText(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

function slugForFile(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ocr';
}

function roundPercent(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeToPokemonCard(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: 734, height: 1024, fit: 'fill' })
    .jpeg({ quality: 95 })
    .toBuffer();
}

function extractPokemonMicroRegion(
  image: sharp.Sharp,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  upscale: number,
  contrast: number,
  brightness: number
): Promise<Buffer> {
  const left = Math.floor(width * x1);
  const top = Math.floor(height * y1);
  const cropWidth = Math.max(1, Math.floor(width * x2) - left);
  const cropHeight = Math.max(1, Math.floor(height * y2) - top);
  return image
    .clone()
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({ width: cropWidth * upscale, height: cropHeight * upscale, fit: 'fill' })
    .grayscale()
    .normalize()
    .linear(contrast, brightness)
    .sharpen({ sigma: 1.2 })
    .png()
    .toBuffer();
}

function validatePokemonCardName(raw?: string, confidence = 100): { accepted: boolean; cleanedName?: string; reason?: string } {
  const knownName = normalizeKnownPokemonName(raw);
  if (knownName && confidence >= 8) {
    return { accepted: true, cleanedName: knownName };
  }
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
  const knownName = normalizeKnownPokemonName(rawName);
  if (knownName) return knownName;

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

  return normalizeKnownPokemonName(name) ?? name.trim();
}

function extractPokemonFields(
  regionTexts: Partial<Record<OcrRegionName, string>>,
  nameValidation = validatePokemonCardName(regionTexts.name)
): ExtractedCardDetails {
  const combined = [
    regionTexts.name,
    regionTexts.hp,
    regionTexts.attack,
    regionTexts.bottom,
    regionTexts.collector,
    regionTexts.collectorRight,
    regionTexts.collectorClassic,
    regionTexts.collectorPromo,
    regionTexts.collectorFused
  ].filter(Boolean).join('\n');
  const collectorText = [
    regionTexts.collectorFused,
    regionTexts.collectorClassic,
    regionTexts.collectorPromo,
    regionTexts.collectorRight,
    regionTexts.collector,
    regionTexts.bottom
  ].filter(Boolean).join('\n');
  const collectorInfo = parsePokemonCardNumberEvidence(collectorText);
  return {
    name: nameValidation.accepted ? nameValidation.cleanedName : undefined,
    cardNumber: collectorInfo.cardNumber ?? extractPokemonCardNumber(collectorText),
    localId: collectorInfo.localId,
    printedNumber: collectorInfo.printedNumber,
    collectorNumber: collectorInfo.collectorNumber,
    printedTotal: collectorInfo.printedTotal,
    setCode: collectorInfo.setCode ?? extractPokemonSetCode(collectorText),
    setName: collectorInfo.setName,
    language: detectLanguage(combined),
    rarity: extractRarity(regionTexts.bottom ?? combined),
    hp: extractPokemonHp(regionTexts.hp ?? regionTexts.name ?? combined),
    damage: extractPokemonDamage(regionTexts.attackDamage ?? ''),
    year: extractPokemonCopyrightYear(regionTexts.bottom ?? combined),
    attackNameHint: extractPokemonAttackHint(regionTexts.attack ?? combined)
  };
}

function extractPokemonCardNumber(text: string): string | undefined {
  const collectorInfo = parsePokemonCardNumberEvidence(text);
  if (collectorInfo.cardNumber) return collectorInfo.cardNumber;
  const source = collectorInfo.rawCollectorText;

  const patterns = [
    /\b\d{1,3}\/\d{1,3}\b/i,
    /\b[A-Z]{1,3}\d{1,3}\/[A-Z]{1,3}\d{1,3}\b/i,
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
  const collectorInfo = parsePokemonCardNumberEvidence(text);
  if (collectorInfo.setCode) return collectorInfo.setCode;
  const source = collectorInfo.rawCollectorText;
  return source.match(/\b(sv\d{0,2}|swsh\d+|xy\d{0,2}|sm\d{0,2}|bw\d{0,2})\b/i)?.[1]?.toUpperCase();
}

function buildCollectorNumberCandidates(attempts: PokemonOcrAttempt[]): CollectorNumberCandidate[] {
  const votes = new Map<string, CollectorNumberCandidate>();

  for (const attempt of attempts) {
    for (const region of attempt.regions) {
      if (!isCollectorCandidateRegion(region.region)) continue;
      const parsed = parsePokemonCardNumberEvidence(region.text);
      const values = new Set<string>();
      if (parsed.cardNumber) values.add(parsed.cardNumber);
      if (parsed.printedNumber) values.add(parsed.printedNumber);
      if (parsed.collectorNumber) values.add(parsed.collectorNumber);

      const normalized = parsed.rawCollectorText;
      if (/\bSVP(?:\s*EN)?\b/i.test(normalized)) {
        for (const match of normalized.matchAll(/\b(?!202[0-9]\b)(\d{1,3})\b/g)) {
          values.add(match[1]);
        }
      }

      for (const value of values) {
        if (isBogusCollectorNumberValue(value)) continue;
        const key = normalizeCardNumberForVote(value);
        if (!key) continue;
        const current = votes.get(key);
        const source = `${attempt.name}:${region.region}`;
        if (current) {
          current.votes += 1;
          current.source = `${current.source}, ${source}`;
          current.rawText = [current.rawText, region.text].filter(Boolean).join(' | ');
        } else {
          votes.set(key, {
            value,
            localId: parsed.localId,
            printedNumber: parsed.printedNumber,
            printedTotal: parsed.printedTotal,
            setCode: parsed.setCode,
            setName: parsed.setName,
            source,
            votes: 1,
            confidence: 'low',
            rawText: region.text
          });
        }
      }
    }
  }

  return [...votes.values()]
    .map((candidate) => ({
      ...candidate,
      confidence: candidate.votes >= 3 ? 'high' as const : candidate.votes >= 2 ? 'medium' as const : 'low' as const
    }))
    .sort((a, b) => b.votes - a.votes || confidenceRank(b.confidence) - confidenceRank(a.confidence));
}

function getCollectorNumberConfidence(candidates: CollectorNumberCandidate[], chosen: string | null): 'low' | 'medium' | 'high' {
  const candidate = candidates.find((entry) => normalizeCardNumberForVote(entry.value) === normalizeCardNumberForVote(chosen ?? ''));
  return candidate?.confidence ?? 'low';
}

function normalizeCardNumberForVote(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/]+/g, '');
}

function isCollectorCandidateRegion(region: OcrRegionName): boolean {
  return region === 'collector' ||
    region === 'collectorRight' ||
    region === 'collectorClassic' ||
    region === 'collectorPromo' ||
    region === 'collectorFused' ||
    region === 'bottom';
}

function isBogusCollectorNumberValue(value: string): boolean {
  const normalized = normalizeCardNumberForVote(value);
  return normalized === '0' ||
    normalized === '00' ||
    normalized === '000' ||
    normalized === '0000' ||
    /^(19|20)\d{2}$/.test(normalized);
}

function confidenceRank(value: 'low' | 'medium' | 'high'): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function extractRarity(text: string): string | undefined {
  return text.match(/\b(common|uncommon|rare|double rare|illustration rare|special illustration rare|ultra rare|hyper rare|promo|secret rare)\b/i)?.[1];
}

function extractPokemonHp(text: string): string | undefined {
  return extractPokemonHpValue(text);
}

function extractPokemonDamage(text: string): string | undefined {
  if (/\b(weight|lbs?|kg|height)\b/i.test(text)) return undefined;
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

function scorePokemonTextQuality(text: string): number {
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const suspiciousSymbols = text.match(/[=«»<>~_{}[\]\\|]/g)?.length ?? 0;
  if (!text.trim()) return -1;
  return Math.max(-2, Math.min(1, letters / 80 - suspiciousSymbols * 0.35));
}

function mergePokemonAttempts(attempts: PokemonOcrAttempt[], cropWidth: number, cropHeight: number): PokemonOcrAttempt {
  const pick = (field: keyof ExtractedCardDetails) =>
    attempts
      .filter((attempt) => Boolean(attempt.extracted[field]))
      .sort((a, b) => b.usefulnessScore - a.usefulnessScore || b.averageConfidence - a.averageConfidence)[0]?.extracted[field];
  const evidenceAttempts = attempts.flatMap((attempt) => attempt.evidenceAttempts ?? []);
  const selectedEvidence = attempts.reduce<PokemonOcrAttempt['selectedEvidence']>((selected, attempt) => ({
    ...selected,
    ...attempt.selectedEvidence
  }), {});
  const extracted: ExtractedCardDetails = {
    name: pick('name'),
    cardNumber: pick('cardNumber'),
    localId: pick('localId'),
    printedNumber: pick('printedNumber'),
    collectorNumber: pick('collectorNumber'),
    printedTotal: pick('printedTotal'),
    setCode: pick('setCode'),
    setName: pick('setName'),
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
    usefulnessScore: scorePokemonUsefulness(extracted, Boolean(extracted.name), averageConfidence) + scorePokemonTextQuality(attempts.map((attempt) => attempt.cleanedText).join('\n')),
    averageConfidence,
    evidenceAttempts: evidenceAttempts.length ? evidenceAttempts : undefined,
    selectedEvidence: Object.keys(selectedEvidence ?? {}).length ? selectedEvidence : undefined
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
