import { v4 as uuidv4 } from 'uuid';
import type { CardCandidate, CardScanResult, DetectCardInput, OcrDebugInfo, PublicCardMatch, PublicDetectedDetails } from '../types/cards.js';
import { withTimeout } from '../utils/async.js';
import { CardSearchService } from './cardSearchService.js';
import { GradingPrepService } from './gradingPrepService.js';
import { CardBoundaryDetectionError, ImagePreprocessService } from './imagePreprocessService.js';
import { OcrService } from './ocrService.js';
import { PriceService } from './priceService.js';
import { ScanPersistenceService } from './scanPersistenceService.js';

export class CardDetectionService {
  constructor(
    private readonly imagePreprocessService = new ImagePreprocessService(),
    private readonly ocrService = new OcrService(),
    private readonly cardSearchService = new CardSearchService(),
    private readonly priceService = new PriceService(),
    private readonly gradingPrepService = new GradingPrepService(),
    private readonly scanPersistenceService = new ScanPersistenceService()
  ) {}

  async detect(input: DetectCardInput): Promise<CardScanResult> {
    const scanId = uuidv4();
    return withTimeout(this.detectInternal(scanId, input), 25000, 'Could not detect card. Please try a clearer image or select the card game manually.');
  }

  async confirm(scanId: string, confirmedCardId: string, confirmedSource: string, confirmedCandidate?: PublicCardMatch) {
    return this.scanPersistenceService.markConfirmed(scanId, { confirmedCardId, confirmedSource, confirmedCandidate });
  }

  async getRecentScans() {
    return this.scanPersistenceService.getRecent();
  }

  private async detectInternal(scanId: string, input: DetectCardInput): Promise<CardScanResult> {
    const warnings: string[] = [];
    this.log(scanId, 'image uploaded');
    let preprocessing;
    try {
      preprocessing = await this.imagePreprocessService.preprocess(scanId, input.imageBuffer, {
        manualCrop: input.manualCrop
      });
    } catch (error) {
      if (error instanceof CardBoundaryDetectionError) {
        this.log(scanId, `original image size: ${error.originalWidth}x${error.originalHeight}`);
        this.log(scanId, 'card boundary detection failed');
        const partial: CardScanResult = {
          scanId,
          status: 'partial',
          rawImageUrl: error.rawImageUrl,
          detectedGame: input.selectedGame,
          detectedDetails: {},
          alternatives: [],
          needsUserConfirmation: true,
          warnings: ['Automatic card detection could not isolate the card from the background.'],
          manualSearchSuggested: true,
          message: error.message
        };
        await this.scanPersistenceService.save(
          this.scanPersistenceService.buildRecord(partial, {
            selectedGame: input.selectedGame,
            selectedLanguage: input.selectedLanguage,
            rawImagePath: error.rawImagePath
          })
        );
        return partial;
      }
      throw error;
    }
    this.log(scanId, 'image preprocessed');
    this.log(scanId, `original image size: ${preprocessing.diagnostics.originalWidth}x${preprocessing.diagnostics.originalHeight}`);
    if (preprocessing.diagnostics.cardDetection) {
      this.log(scanId, `detected card coordinates: ${JSON.stringify(preprocessing.diagnostics.cardDetection.corners)}`);
      this.log(scanId, `aspect ratio: ${preprocessing.diagnostics.cardDetection.aspectRatio.toFixed(3)}`);
      this.log(scanId, `confidence score: ${preprocessing.diagnostics.cardDetection.confidence.toFixed(2)}`);
    }

    let ocrText = '';
    let extracted = {};
    let ocrDebug: OcrDebugInfo = {};
    try {
      this.log(scanId, 'OCR started');
      const ocr = await this.ocrService.readCard(preprocessing.normalizedBuffer, {
        scanId,
        selectedGame: input.selectedGame
      });
      ocrText = ocr.ocrText;
      extracted = ocr.extracted;
      ocrDebug = ocr.debug;
      this.log(scanId, `OCR name region text: ${ocr.debug.regionTexts?.name ?? 'n/a'}`);
      this.log(scanId, `OCR bottom region text: ${ocr.debug.regionTexts?.bottom ?? 'n/a'}`);
      this.log(scanId, `OCR attack region text: ${ocr.debug.regionTexts?.attack ?? 'n/a'}`);
      this.log(scanId, `cleaned card name: ${ocr.extracted.name ?? 'rejected/empty'}`);
      this.log(scanId, `final cleaned extracted fields: ${JSON.stringify(ocr.extracted)}`);
      if (ocr.debug.rejectedCardNameReason) {
        this.log(scanId, `rejected card name reason: ${ocr.debug.rejectedCardNameReason}`);
      }
      this.log(scanId, 'OCR completed');
    } catch (error) {
      warnings.push('OCR could not confidently read the card. Manual selection is recommended.');
      this.log(scanId, `OCR failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    let topMatch;
    let alternatives: CardCandidate[] = [];
    let queriesUsed: string[] = [];
    if (input.selectedGame) {
      try {
        this.log(scanId, 'API search started');
        const search = await withTimeout(
          this.cardSearchService.search(extracted, input.selectedGame, input.selectedLanguage),
          10000,
          'Card database search took too long.'
        );
        topMatch = search.topMatch ? this.priceService.enrichCandidate(search.topMatch) : undefined;
        alternatives = search.alternatives.map((candidate) => this.priceService.enrichCandidate(candidate));
        queriesUsed = search.queriesUsed;
        this.log(scanId, `final API query used: ${queriesUsed[queriesUsed.length - 1] ?? 'no query executed'}`);
        this.log(scanId, 'API search completed');
      } catch (error) {
        warnings.push('Card search failed. You can still use OCR details to select the card manually.');
        this.log(scanId, `API search failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    } else {
      warnings.push('Select the card game to speed up detection and improve match quality.');
      this.log(scanId, 'API search skipped because no game was selected');
    }

    const detectedDetails = this.buildDetectedDetails(extracted, topMatch);
    const closestMatch = topMatch ? this.toPublicMatch(topMatch) : undefined;
    const publicAlternatives = alternatives.map((candidate) => this.toPublicMatch(candidate));

    const result: CardScanResult = {
      scanId,
      status: topMatch ? 'success' : warnings.length ? 'partial' : 'error',
      rawImageUrl: preprocessing.rawImageUrl,
      normalizedImageUrl: preprocessing.normalizedImageUrl,
      detectedGame: topMatch?.game ?? input.selectedGame,
      detectedDetails,
      closestMatch,
      alternatives: publicAlternatives,
      needsUserConfirmation: !topMatch || (topMatch.confidence ?? 0) < 0.85,
      imageDiagnostics: preprocessing.diagnostics,
      gradingPrep: undefined,
      warnings,
      manualSearchSuggested: !topMatch,
      message: topMatch
        ? 'Card detection completed.'
        : 'Could not detect card. Please try a clearer image or select the card game manually.',
      debug: {
        ocrText,
        ocrDigest: this.toOcrDigest(ocrText),
        confidence: topMatch?.confidence,
        queriesUsed,
        ocr: ocrDebug
      }
    };

    result.gradingPrep = this.gradingPrepService.prepare(result);

    await this.scanPersistenceService.save(
      this.scanPersistenceService.buildRecord(result, {
        selectedGame: input.selectedGame,
        selectedLanguage: input.selectedLanguage,
        rawImagePath: preprocessing.rawImagePath,
        normalizedImagePath: preprocessing.normalizedImagePath
      })
    );

    this.log(scanId, 'result returned');
    return result;
  }

  private log(scanId: string, message: string) {
    console.log(`[card-detect:${scanId}] ${message}`);
  }

  private buildDetectedDetails(extracted: Record<string, unknown>, topMatch?: CardCandidate): PublicDetectedDetails {
    const extractedDetails = extracted as {
      name?: string;
      cardNumber?: string;
      setCode?: string;
      language?: string;
      rarity?: string;
    };

    return {
      cardName: cleanField(extractedDetails.name ?? topMatch?.name),
      cardNumber: cleanField(extractedDetails.cardNumber ?? topMatch?.cardNumber),
      language: cleanLanguage(extractedDetails.language ?? topMatch?.language),
      setOrSeries: cleanField(extractedDetails.setCode ?? topMatch?.setName ?? topMatch?.setCode),
      rarity: cleanField(extractedDetails.rarity ?? topMatch?.rarity)
    };
  }

  private toPublicMatch(candidate: CardCandidate): PublicCardMatch {
    return {
      id: candidate.id,
      source: candidate.source,
      game: candidate.game,
      cardName: candidate.name,
      cardNumber: candidate.cardNumber,
      language: cleanLanguage(candidate.language),
      setOrSeries: candidate.setName ?? candidate.setCode,
      rarity: candidate.rarity,
      imageUrl: candidate.imageUrl,
      estimatedValue: candidate.prices
    };
  }

  private toOcrDigest(ocrText: string): string {
    return ocrText
      .split('\n')
      .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' | ');
  }
}

function cleanField(value?: string): string | undefined {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function cleanLanguage(value?: string): string | undefined {
  const normalized = cleanField(value)?.toLowerCase();
  if (!normalized) return undefined;
  const map: Record<string, string> = {
    en: 'English',
    english: 'English',
    ja: 'Japanese',
    japanese: 'Japanese',
    fr: 'French',
    french: 'French',
    de: 'German',
    german: 'German',
    es: 'Spanish',
    spanish: 'Spanish'
  };
  return map[normalized] ?? value;
}
