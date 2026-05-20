import { v4 as uuidv4 } from 'uuid';
import type { ApiSearchDebugEntry, CardCandidate, CardMatchDebugInfo, CardScanResult, DetectCardInput, OcrDebugInfo, PublicCardMatch, PublicDetectedDetails } from '../types/cards.js';
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
    const selectedLanguage = normalizeLanguage(input.selectedLanguage);
    this.log(scanId, 'image uploaded');
    let backImagePath: string | undefined;
    if (input.backImageBuffer) {
      const backImage = await this.imagePreprocessService.saveBackImage(scanId, input.backImageBuffer);
      backImagePath = backImage.path;
      this.log(scanId, 'back image saved for future grading; identification OCR will use front image only');
    }
    let preprocessing;
    try {
      this.log(scanId, 'image preprocessing started');
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
          message: error.message,
          debug: input.debugMode ? {
            identification: {
              selectedGame: input.selectedGame,
              selectedLanguage: input.selectedLanguage,
              uploadedImageUrl: error.rawImageUrl,
              extractedFields: {},
              queriesUsed: [],
              topMatches: []
            }
          } : undefined
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
    this.log(scanId, 'image preprocessing finished');
    this.log(scanId, `original image size: ${preprocessing.diagnostics.originalWidth}x${preprocessing.diagnostics.originalHeight}`);
    if (preprocessing.diagnostics.cardDetection) {
      this.log(scanId, `detected card coordinates: ${JSON.stringify(preprocessing.diagnostics.cardDetection.corners)}`);
      this.log(scanId, `aspect ratio: ${preprocessing.diagnostics.cardDetection.aspectRatio.toFixed(3)}`);
      this.log(scanId, `confidence score: ${preprocessing.diagnostics.cardDetection.confidence.toFixed(2)}`);
    }
    if (preprocessing.diagnostics.cropValidation) {
      const crop = preprocessing.diagnostics.cropValidation;
      this.log(scanId, `crop validation: width=${crop.cropWidth} height=${crop.cropHeight} area=${crop.cropArea} originalArea=${crop.originalArea} ratio=${crop.cropAreaRatio} valid=${crop.valid}`);
      if (crop.reasons.length) this.log(scanId, `crop rejected reasons: ${crop.reasons.join(' | ')}`);
    }

    let ocrText = '';
    let extracted: Record<string, string | undefined> = {};
    let ocrDebug: OcrDebugInfo = {};
    let ocrReadable = false;
    try {
      this.log(scanId, 'OCR started');
      const ocr = await this.ocrService.readCard(preprocessing.normalizedBuffer, {
        scanId,
        selectedGame: input.selectedGame,
        frontImageBuffer: preprocessing.rawBuffer,
        cropValid: preprocessing.diagnostics.cropValid,
        cropMode: preprocessing.diagnostics.crop?.mode
      });
      ocrText = ocr.ocrText;
      this.log(scanId, `raw OCR text: ${truncateForLog(ocr.ocrText)}`);
      this.log(scanId, `top crop OCR text: ${ocr.debug.regionTexts?.name ?? 'n/a'} ${ocr.debug.regionTexts?.hp ?? ''}`.trim());
      this.log(scanId, `bottom crop OCR text: ${ocr.debug.regionTexts?.bottom ?? 'n/a'}`);
      this.log(scanId, `parsed fields before cleaning: ${JSON.stringify(ocr.extracted)}`);
      extracted = {
        ...ocr.extracted,
        name: cleanPokemonName(ocr.extracted.name),
        cardNumber: normalizeCollectorNumber(ocr.extracted.cardNumber),
        language: selectedLanguage
      };
      ocrDebug = ocr.debug;
      ocrDebug.extracted = {
        ...ocrDebug.extracted,
        ...extracted
      };
      ocrReadable = !ocr.debug.weakResultReason;
      for (const attempt of ocr.debug.attempts ?? []) {
        this.log(scanId, `OCR attempt "${attempt.name}" crop size: ${attempt.cropWidth}x${attempt.cropHeight}`);
        this.log(scanId, `OCR attempt "${attempt.name}" raw text: ${truncateForLog(attempt.rawText)}`);
        this.log(scanId, `OCR attempt "${attempt.name}" cleaned text: ${truncateForLog(attempt.cleanedText)}`);
        this.log(scanId, `OCR attempt "${attempt.name}" extracted fields: ${JSON.stringify(attempt.extracted)}`);
        this.log(scanId, `OCR attempt "${attempt.name}" usefulness score: ${attempt.usefulnessScore}`);
      }
      this.log(scanId, `OCR name region text: ${ocr.debug.regionTexts?.name ?? 'n/a'}`);
      this.log(scanId, `OCR bottom region text: ${ocr.debug.regionTexts?.bottom ?? 'n/a'}`);
      this.log(scanId, `OCR attack region text: ${ocr.debug.regionTexts?.attack ?? 'n/a'}`);
      this.log(scanId, `cleaned card name: ${extracted.name ?? 'rejected/empty'}`);
      this.log(scanId, `parsed fields after cleaning: ${JSON.stringify(extracted)}`);
      this.log(scanId, `final cleaned extracted fields: ${JSON.stringify(extracted)}`);
      if (ocr.debug.rejectedCardNameReason) {
        this.log(scanId, `rejected card name reason: ${ocr.debug.rejectedCardNameReason}`);
      }
      if (ocr.debug.weakResultReason) {
        this.log(scanId, `OCR weak result reason: ${ocr.debug.weakResultReason}`);
      }
      this.log(scanId, 'OCR completed');
    } catch (error) {
      warnings.push('OCR could not confidently read the card. Manual selection is recommended.');
      this.log(scanId, `OCR failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    let topMatch;
    let alternatives: CardCandidate[] = [];
    let queriesUsed: string[] = [];
    let apiCalls: ApiSearchDebugEntry[] = [];
    const canSearch = isSearchableExtraction(extracted, input.selectedGame);
    if (!ocrReadable && !canSearch) {
      warnings.push('Card text could not be read clearly. Please try another photo.');
      this.log(scanId, 'API search skipped because OCR did not produce searchable Pokemon fields');
    } else if (input.selectedGame && canSearch) {
      try {
        this.log(scanId, 'API search started');
        this.log(scanId, `extracted cardName: ${String((extracted as { name?: string }).name ?? '') || 'n/a'}`);
        this.log(scanId, `extracted cardNumber: ${String((extracted as { cardNumber?: string }).cardNumber ?? '') || 'n/a'}`);
        this.log(scanId, `extracted setCode: ${String((extracted as { setCode?: string }).setCode ?? '') || 'n/a'}`);
        const search = await withTimeout(
          this.cardSearchService.search(extracted, input.selectedGame, selectedLanguage),
          15000,
          'Card database search took too long.'
        );
        topMatch = search.topMatch ? this.priceService.enrichCandidate(search.topMatch) : undefined;
        alternatives = search.alternatives.map((candidate) => this.priceService.enrichCandidate(candidate));
        queriesUsed = search.queriesUsed;
        apiCalls = search.apiCalls ?? [];
        const winningQuery = getWinningQuery(topMatch, extracted, queriesUsed);
        this.log(scanId, `final API query used: ${winningQuery ?? 'no query executed'}`);
        for (const call of apiCalls) {
          this.log(
            scanId,
            `API call source=${call.source} type=${call.searchType} endpoint=${call.endpoint} status=${call.status ?? 'error'} results=${call.resultCount ?? 0} topMatch=${call.topMatchName ?? 'n/a'}${call.error ? ` error=${call.error}` : ''}`
          );
        }
        this.log(scanId, `API search result count: ${topMatch ? 1 + alternatives.length : 0}`);
        this.log(scanId, `API response count: ${topMatch ? 1 + alternatives.length : 0}`);
        this.log(scanId, `top match name: ${topMatch?.name ?? 'n/a'}`);
        this.log(scanId, `confidence score: ${topMatch?.confidence ?? 0}`);
        this.log(scanId, 'API search completed');
      } catch (error) {
        warnings.push('Card search failed. You can still use OCR details to select the card manually.');
        this.log(scanId, `API search failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    } else if (input.selectedGame) {
      warnings.push('Card text could not be read clearly. Please try another photo.');
      this.log(scanId, 'API search skipped because extracted fields were not valid enough for card search');
    } else {
      warnings.push('Select the card game to speed up detection and improve match quality.');
      this.log(scanId, 'API search skipped because no game was selected');
    }

    const detectedDetails = this.buildDetectedDetails(extracted, topMatch);
    const closestMatch = topMatch ? this.toPublicMatch(topMatch) : undefined;
    const publicAlternatives = alternatives.map((candidate) => this.toPublicMatch(candidate));
    const debugMatches = [topMatch, ...alternatives].filter(Boolean).map((candidate) => this.toDebugMatch(candidate as CardCandidate));
    const cropWarnings = preprocessing.diagnostics.crop?.warnings ?? [];
    const detectionNotes = [
      ...warnings,
      ...cropWarnings,
      ...(preprocessing.diagnostics.blurScore < 40 ? ['Photo may be blurry. Retake with the camera held steady if detection looks wrong.'] : []),
      ...(preprocessing.diagnostics.glareScore > 0.83 ? ['Photo may have glare or very bright reflections.'] : [])
    ];
    const needsManualCrop =
      !topMatch &&
      preprocessing.diagnostics.crop?.mode === 'fallback_center' &&
      (!canSearch || !detectedDetails.cardName);
    const resultStatus: CardScanResult['status'] = needsManualCrop
      ? 'needs_manual_crop'
      : topMatch
        ? 'success'
        : canSearch
          ? 'needs_manual_review'
          : warnings.length
            ? 'partial'
            : 'error';

    const debugPayload: CardScanResult['debug'] = input.debugMode
      ? {
          ocrText,
          ocrDigest: this.toOcrDigest(ocrText),
          confidence: topMatch?.confidence,
          queriesUsed,
          ocr: ocrDebug,
          api: {
            query: getWinningQuery(topMatch, extracted, queriesUsed),
            responseCount: topMatch ? 1 + publicAlternatives.length : 0,
            topResultName: closestMatch?.cardName,
            calls: apiCalls
          },
          identification: {
            selectedGame: input.selectedGame,
            selectedLanguage,
            uploadedImageUrl: preprocessing.rawImageUrl,
            normalizedImageUrl: preprocessing.normalizedImageUrl,
            rawOcrText: ocrText,
            cleanedOcrText: ocrDebug.cleanedText,
            extractedFields: ocrDebug.extracted ?? (extracted as {
              name?: string;
              cardNumber?: string;
              setCode?: string;
              language?: string;
              rarity?: string;
              hp?: string;
              damage?: string;
              year?: string;
              attackNameHint?: string;
            }),
            queriesUsed,
            topMatches: debugMatches
          }
        }
      : undefined;

    const result: CardScanResult = {
      scanId,
      success: Boolean(topMatch),
      status: resultStatus,
      rawImageUrl: preprocessing.rawImageUrl,
      normalizedImageUrl: preprocessing.normalizedImageUrl,
      detectedGame: topMatch?.game ?? input.selectedGame,
      detectedDetails,
      closestMatch,
      officialMatch: closestMatch ?? null,
      estimatedValue: closestMatch?.estimatedValue ?? null,
      alternatives: publicAlternatives,
      possibleMatches: publicAlternatives,
      needsUserConfirmation: !topMatch || (topMatch.confidence ?? 0) < 0.85,
      imageDiagnostics: preprocessing.diagnostics,
      crop: preprocessing.diagnostics.crop,
      gradingPrep: undefined,
      warnings,
      detectionNotes,
      manualSearchSuggested: !topMatch || needsManualCrop,
      message: needsManualCrop
        ? 'We could not confidently detect the full card. Please adjust the crop around the card.'
        : topMatch
          ? 'Card detection completed.'
          : canSearch
            ? 'Review needed. Possible matches were returned for manual confirmation.'
            : 'Card text could not be read clearly. Please try another photo.',
      debug: debugPayload
    };

    result.gradingPrep = this.gradingPrepService.prepare(result);

    await this.scanPersistenceService.save(
      this.scanPersistenceService.buildRecord(result, {
        selectedGame: input.selectedGame,
        selectedLanguage,
        rawImagePath: preprocessing.rawImagePath,
        normalizedImagePath: preprocessing.normalizedImagePath,
        backImagePath
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
      hp?: string;
    };

    return {
      cardName: cleanField(extractedDetails.name ?? topMatch?.name) ?? null,
      cardNumber: cleanField(extractedDetails.cardNumber) ?? null,
      language: normalizeLanguage(extractedDetails.language ?? topMatch?.language),
      setCode: cleanField(extractedDetails.setCode) ?? null,
      setSeries: cleanField(extractedDetails.setCode) ?? null,
      setOrSeries: cleanField(extractedDetails.setCode) ?? null,
      hp: cleanField(extractedDetails.hp) ?? null,
      rarity: cleanField(extractedDetails.rarity ?? topMatch?.rarity) ?? null
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

  private toDebugMatch(candidate: CardCandidate): CardMatchDebugInfo {
    return {
      id: candidate.id,
      source: candidate.source,
      game: candidate.game,
      cardName: candidate.name,
      cardNumber: candidate.cardNumber,
      setOrSeries: candidate.setName ?? candidate.setCode,
      rarity: candidate.rarity,
      imageUrl: candidate.imageUrl,
      confidence: candidate.confidence,
      confidenceReasons: candidate.confidenceReasons ?? []
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

function normalizeLanguage(language = 'English'): string {
  const value = String(language).toLowerCase();
  if (value.includes('english') || value === 'en') return 'English';
  if (value.includes('japanese') || value === 'ja') return 'Japanese';
  if (value.includes('french') || value === 'fr') return 'French';
  if (value.includes('spanish') || value === 'es') return 'Spanish';
  if (value.includes('german') || value === 'de') return 'German';
  if (value.includes('italian') || value === 'it') return 'Italian';
  if (value.includes('korean') || value === 'ko') return 'Korean';
  if (value.includes('chinese') || value === 'zh') return 'Chinese';
  return 'English';
}

function cleanPokemonName(rawName = ''): string | undefined {
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

  const letters = name.match(/[A-Za-z]/g)?.length ?? 0;
  const symbols = name.match(/[^A-Za-z0-9\s.'’:-]/g)?.length ?? 0;
  if (!name || letters < 3 || symbols > letters) return undefined;
  return name.trim();
}

function normalizeCollectorNumber(value?: string): string | undefined {
  if (!value || value === 'Not found') return undefined;
  const source = String(value);
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

function getWinningQuery(topMatch: CardCandidate | undefined, extracted: Record<string, unknown>, queriesUsed: string[]): string | undefined {
  const name = cleanField(String((extracted as { name?: string }).name ?? ''));
  if (topMatch?.source && name) {
    const sourceNameQuery = queriesUsed.find((query) => query === `${topMatch.source}:name:${name}`);
    if (sourceNameQuery) return sourceNameQuery;
  }
  if (name) {
    const pokemonNameQuery = queriesUsed.find((query) => query === `pokemon-tcg-api:name:${name}`);
    if (pokemonNameQuery) return pokemonNameQuery;
  }
  return queriesUsed.find((query) => !query.includes(':attack:')) ?? queriesUsed[0];
}

function isSearchableExtraction(extracted: Record<string, unknown>, selectedGame?: string): boolean {
  const details = extracted as {
    name?: string;
    cardNumber?: string;
    setCode?: string;
    attackNameHint?: string;
  };
  if (!selectedGame) return false;
  if (selectedGame.toLowerCase().includes('pokemon')) {
    if (isValidSearchName(details.name)) return true;
    if (details.cardNumber && details.cardNumber !== 'Not found' && details.setCode) return true;
    return false;
  }
  return Boolean(isValidSearchName(details.name) || (details.cardNumber && details.cardNumber !== 'Not found'));
}

function isValidSearchName(value?: string): boolean {
  if (!value) return false;
  const letters = value.match(/[A-Za-z]/g)?.length ?? 0;
  const symbols = value.match(/[^A-Za-z0-9\s.'’:-]/g)?.length ?? 0;
  if (letters < 3) return false;
  if (symbols > letters) return false;
  if (/[=«»<>~_{}[\]\\|]/.test(value) && letters < 5) return false;
  return true;
}

function truncateForLog(value: string, max = 600): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}
