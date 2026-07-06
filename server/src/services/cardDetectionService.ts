import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import { findPokemonFallbackCard, type PokemonFallbackCard } from '../data/pokemonFallbackCards.js';
import type { ApiSearchDebugEntry, CardCandidate, CardMatchDebugInfo, CardScanResult, CorrectCardInput, DetectCardInput, ExtractedCardDetails, IdentityResultDecision, MatchEvidence, OcrDebugInfo, PublicCardMatch, PublicDetectedDetails, ScanQuality } from '../types/cards.js';
import { withTimeout } from '../utils/async.js';
import { normalizeKnownPokemonName, normalizePokemonCardNumber, pokemonCardNumbersMatch } from '../utils/pokemonText.js';
import { CardIdentificationService } from './cardIdentificationService.js';
import { CardPricingService } from './cardPricingService.js';
import { ConditionGradingService } from './conditionGradingService.js';
import { GradingPrepService } from './gradingPrepService.js';
import { CardBoundaryDetectionError, ImagePreprocessService } from './imagePreprocessService.js';
import { OcrService } from './ocrService.js';
import { ScanPersistenceService } from './scanPersistenceService.js';

export class CardDetectionService {
  constructor(
    private readonly imagePreprocessService = new ImagePreprocessService(),
    private readonly ocrService = new OcrService(),
    private readonly cardIdentificationService = new CardIdentificationService(),
    private readonly cardPricingService = new CardPricingService(),
    private readonly gradingPrepService = new GradingPrepService(),
    private readonly conditionGradingService = new ConditionGradingService(),
    private readonly scanPersistenceService = new ScanPersistenceService()
  ) {}

  async detect(input: DetectCardInput): Promise<CardScanResult> {
    const scanId = uuidv4();
    return withTimeout(this.detectInternal(scanId, input), 25000, 'Could not detect card. Please try a clearer image or select the card game manually.');
  }

  async confirm(scanId: string, confirmedCardId: string, confirmedSource: string, confirmedCandidate?: PublicCardMatch) {
    return this.scanPersistenceService.markConfirmed(scanId, { confirmedCardId, confirmedSource, confirmedCandidate });
  }

  async correct(input: CorrectCardInput): Promise<CardScanResult | null> {
    const existing = await this.scanPersistenceService.getById(input.scanId);
    if (!existing) return null;

    const selectedLanguage = normalizeLanguage(input.language ?? existing.selectedLanguage ?? existing.detectedDetails.language ?? 'English');
    const extracted: ExtractedCardDetails = {
      name: cleanPokemonName(input.cardName ?? existing.detectedDetails.cardName ?? ''),
      cardNumber: normalizeCollectorNumber(input.cardNumber ?? existing.detectedDetails.cardNumber ?? '', input.setCode ?? existing.detectedDetails.setCode ?? undefined),
      setCode: cleanField(input.setCode ?? existing.detectedDetails.setCode ?? undefined),
      language: selectedLanguage,
      hp: existing.detectedDetails.hp ?? undefined,
      rarity: existing.detectedDetails.rarity ?? undefined,
      year: existing.detectedDetails.year ?? undefined
    };

    let search: { topMatch?: CardCandidate; alternatives: CardCandidate[]; queriesUsed: string[]; apiCalls?: ApiSearchDebugEntry[] };
    let correctionSearchError: string | undefined;
    try {
      search = await withTimeout(
        this.cardIdentificationService.identify(extracted, existing.selectedGame ?? existing.detectedGame ?? 'pokemon', selectedLanguage, (message) => console.log(`[card-correct:${input.scanId}] ${message}`)),
        15000,
        'Card database search took too long.'
      );
    } catch (error) {
      correctionSearchError = error instanceof Error ? error.message : 'Card database search failed.';
      search = { alternatives: [], queriesUsed: [], apiCalls: [] };
    }
    const topMatch = search.topMatch;
    const alternatives = search.alternatives;
    const numberConflict = hasNumberConflict(extracted, topMatch);
    const hasStrongMatch = Boolean(topMatch && !numberConflict && (topMatch.confidence ?? 0) >= 0.85);
    const detectedDetails = this.buildDetectedDetails(extracted, hasStrongMatch ? topMatch : undefined);
    const fallbackCard = !hasStrongMatch && topMatch?.source !== 'local_fallback_database' ? findPokemonFallbackCard(extracted) : undefined;
    const fallbackMatch = fallbackCard ? this.toFallbackMatch(fallbackCard, selectedLanguage) : null;
    const publicTopMatch = topMatch ? this.toPublicMatch(topMatch) : undefined;
    const officialMatch = hasStrongMatch
      ? publicTopMatch
      : fallbackMatch ?? (numberConflict ? this.buildOcrFallbackMatch(detectedDetails, existing.selectedGame) : publicTopMatch ?? this.buildOcrFallbackMatch(detectedDetails, existing.selectedGame));
    const pricing = await this.cardPricingService.priceCard({
      officialMatch,
      bestCandidate: topMatch,
      detectedDetails,
      confidenceScore: officialMatch?.confidenceScore,
      numberConflict,
      pricingEligible: hasStrongMatch,
      confirmedIdentity: hasStrongMatch,
      log: (message) => console.log(`[card-correct:${input.scanId}] ${message}`)
    });
    if (officialMatch && pricing.estimatedValue) officialMatch.estimatedValue = pricing.estimatedValue;
    const publicPossibleMatches = [topMatch, ...alternatives].filter(Boolean).map((candidate) => this.toPublicMatch(candidate as CardCandidate));
    const status: CardScanResult['status'] = topMatch?.source === 'local_fallback_database' || fallbackMatch ? 'success_with_fallback' : hasStrongMatch ? 'success' : 'needs_manual_review';
    const detectionNotes = [
      ...(existing.detectionNotes ?? []),
      'The search was re-run with manually corrected fields.',
      ...(numberConflict && topMatch
        ? [`A database result was found, but its card number was ${topMatch.cardNumber}, which does not match the corrected card number.`]
        : []),
      ...(fallbackMatch ? ['A local fallback entry matched the corrected fields.'] : []),
      ...(correctionSearchError ? [`Online database lookup failed during correction: ${correctionSearchError}`] : [])
    ];

    const updated: CardScanResult = {
      ...existing,
      success: hasStrongMatch || Boolean(fallbackMatch) || topMatch?.source === 'local_fallback_database',
      status,
      detectedDetails,
      closestMatch: hasStrongMatch ? publicTopMatch : undefined,
      officialMatch,
      estimatedValue: pricing.estimatedValue,
      alternatives: hasStrongMatch ? alternatives.map((candidate) => this.toPublicMatch(candidate)) : publicPossibleMatches,
      possibleMatches: publicPossibleMatches,
      needsUserConfirmation: true,
      detectionNotes,
      manualSearchSuggested: true,
      correctedFields: {
        cardName: input.cardName,
        cardNumber: input.cardNumber,
        setCode: input.setCode,
        language: selectedLanguage,
        manuallyCorrected: true
      },
      matchEvidence: this.buildMatchEvidence(detectedDetails, officialMatch, numberConflict),
      debug: existing.debug
        ? {
            ...existing.debug,
            api: {
              query: getWinningQuery(topMatch, extracted, search.queriesUsed),
              responseCount: publicPossibleMatches.length,
              topResultName: publicTopMatch?.cardName,
              calls: search.apiCalls ?? []
            },
            pricing: {
              providerUsed: pricing.providerUsed,
              cacheStatus: pricing.cacheStatus,
              scrydexCalled: pricing.scrydexCalled,
              scrydexSkippedReason: pricing.scrydexSkippedReason,
              selectedPriceField: pricing.selectedPriceField,
              errorType: pricing.errorType,
              estimatedValue: pricing.estimatedValue
            },
            identification: existing.debug.identification
              ? {
                  ...existing.debug.identification,
                  selectedLanguage,
                  extractedFields: extracted,
                  queriesUsed: search.queriesUsed,
                  topMatches: [topMatch, ...alternatives].filter(Boolean).map((candidate) => this.toDebugMatch(candidate as CardCandidate))
                }
              : undefined
          }
        : undefined,
      message: hasStrongMatch
        ? 'Card detection completed.'
        : fallbackMatch
          ? 'Fallback match found. Please review manually.'
          : 'Review needed. Possible matches were returned for manual confirmation.'
    };

    await this.scanPersistenceService.save({
      ...existing,
      ...updated,
      alternativesFull: updated.alternatives,
      manuallyCorrected: true
    });
    return updated;
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
      this.log(scanId, `collectorNumberCropText: ${ocr.debug.regionTexts?.collector ?? 'n/a'}`);
      this.log(scanId, `collectorNumberRightCropText: ${ocr.debug.regionTexts?.collectorRight ?? 'n/a'}`);
      this.log(scanId, `parsed fields before cleaning: ${JSON.stringify(ocr.extracted)}`);
      extracted = {
        ...ocr.extracted,
        name: cleanPokemonName(ocr.extracted.name),
        cardNumber: normalizeCollectorNumber(ocr.extracted.cardNumber, ocr.extracted.setCode),
        language: selectedLanguage
      };
      ocrDebug = ocr.debug;
      ocrDebug.extracted = {
        ...ocrDebug.extracted,
        ...extracted
      };
      ocrReadable = !ocr.debug.weakResultReason;
      if (ocr.debug.collectorNumberCandidates?.length) {
        this.log(scanId, `collector number candidates: ${JSON.stringify(ocr.debug.collectorNumberCandidates)}`);
      }
      for (const attempt of ocr.debug.attempts ?? []) {
        this.log(scanId, `OCR attempt "${attempt.name}" crop size: ${attempt.cropWidth}x${attempt.cropHeight}`);
        this.log(scanId, `OCR attempt "${attempt.name}" raw text: ${truncateForLog(attempt.rawText)}`);
        this.log(scanId, `OCR attempt "${attempt.name}" cleaned text: ${truncateForLog(attempt.cleanedText)}`);
        this.log(scanId, `OCR attempt "${attempt.name}" extracted fields: ${JSON.stringify(attempt.extracted)}`);
        this.log(scanId, `OCR attempt "${attempt.name}" usefulness score: ${attempt.usefulnessScore}`);
      }
      this.log(scanId, `OCR name region text: ${ocr.debug.regionTexts?.name ?? 'n/a'}`);
      this.log(scanId, `OCR bottom region text: ${ocr.debug.regionTexts?.bottom ?? 'n/a'}`);
      this.log(scanId, `OCR collector region text: ${ocr.debug.regionTexts?.collector ?? 'n/a'}`);
      this.log(scanId, `OCR collector right region text: ${ocr.debug.regionTexts?.collectorRight ?? 'n/a'}`);
      this.log(scanId, `OCR attack region text: ${ocr.debug.regionTexts?.attack ?? 'n/a'}`);
      if (ocr.debug.regionImages) {
        this.log(scanId, `OCR debug crop paths: ${JSON.stringify(ocr.debug.regionImages)}`);
      }
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
          this.cardIdentificationService.identify(extracted, input.selectedGame, selectedLanguage, (message) => this.log(scanId, message)),
          15000,
          'Card database search took too long.'
        );
        topMatch = search.topMatch;
        alternatives = search.alternatives;
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

    const numberConflict = hasNumberConflict(extracted, topMatch);
    const conflictingApiNumber = numberConflict ? topMatch?.cardNumber : undefined;
    const hasStrongMatch = Boolean(topMatch && !numberConflict && (topMatch.confidence ?? 0) >= 0.85);
    const detectedDetails = this.buildDetectedDetails(extracted, hasStrongMatch ? topMatch : undefined);
    const fallbackCard = !hasStrongMatch && topMatch?.source !== 'local_fallback_database' ? findPokemonFallbackCard(extracted) : undefined;
    const fallbackMatch = fallbackCard ? this.toFallbackMatch(fallbackCard, selectedLanguage) : null;
    const fallbackMatchFound = Boolean(fallbackMatch || topMatch?.source === 'local_fallback_database');
    const publicTopMatch = topMatch ? this.toPublicMatch(topMatch) : undefined;
    const closestMatch = hasStrongMatch ? publicTopMatch : undefined;
    const officialMatch = hasStrongMatch
      ? publicTopMatch
      : fallbackMatch ?? (numberConflict ? this.buildOcrFallbackMatch(detectedDetails, input.selectedGame) : publicTopMatch ?? this.buildOcrFallbackMatch(detectedDetails, input.selectedGame));
    const identityDecision = this.buildIdentityDecision({
      hasStrongMatch,
      topMatch,
      detectedDetails,
      numberConflict,
      canSearch,
      warnings,
      ocrDebug
    });
    this.log(scanId, `pricing decision: identityStatus=${identityDecision.status} pricingEligible=${identityDecision.pricingEligible}`);
    const pricing = await this.cardPricingService.priceCard({
      officialMatch,
      bestCandidate: topMatch,
      detectedDetails,
      confidenceScore: officialMatch?.confidenceScore,
      numberConflict,
      pricingEligible: identityDecision.pricingEligible,
      confirmedIdentity: identityDecision.confirmedIdentity,
      log: (message) => this.log(scanId, message)
    });
    if (officialMatch && identityDecision.pricingEligible && pricing.estimatedValue) officialMatch.estimatedValue = pricing.estimatedValue;
    this.log(scanId, `pricing attempted: ${identityDecision.pricingEligible ? 'yes' : 'no'}`);
    this.log(scanId, `Scrydex called: ${pricing.scrydexCalled}`);
    this.log(scanId, `Scrydex skipped reason: ${pricing.scrydexSkippedReason ?? 'n/a'}`);
    this.log(scanId, `pricing provider used: ${pricing.providerUsed}`);
    this.log(scanId, `pricing cache status: ${pricing.cacheStatus}`);
    this.log(scanId, `selected price field: ${pricing.selectedPriceField ?? 'n/a'}`);
    this.log(scanId, `final estimated value: ${JSON.stringify(pricing.estimatedValue)}`);
    const publicPossibleMatches = [topMatch, ...alternatives]
      .filter(Boolean)
      .map((candidate) => this.toPublicMatch(candidate as CardCandidate));
    const publicAlternatives = hasStrongMatch
      ? alternatives.map((candidate) => this.toPublicMatch(candidate))
      : publicPossibleMatches;
    const debugMatches = [topMatch, ...alternatives].filter(Boolean).map((candidate) => this.toDebugMatch(candidate as CardCandidate));
    const cropWarnings = preprocessing.diagnostics.crop?.warnings ?? [];
    const apiCertificateIssue = hasCertificateLookupFailure(apiCalls);
    const apiLookupFailed = Boolean(canSearch && !topMatch && apiCalls.length && apiCalls.every((call) => call.error));
    const detectionNotes = [
      ...warnings,
      ...cropWarnings,
      ...(detectedDetails.cardName ? ['Card name was detected from the image.'] : []),
      ...(detectedDetails.cardNumber || detectedDetails.setCode ? ['Card number/set code were detected from the bottom-left card text if available.'] : []),
      ...(numberConflict
        ? [
            `Card number ${detectedDetails.cardNumber} was detected from the image.`,
            `A database result was found, but its card number was ${conflictingApiNumber}, which does not match the scanned card.`,
            'Showing OCR-detected details instead. Please review manually.',
            'Database match had a different card number than the scanned card, so the result needs review.'
          ]
        : []),
      ...(fallbackMatchFound
        ? [
            'Exact Pokemon TCG API match was not found.',
            'A local fallback entry matched the scanned name, card number, and set code.',
            'Estimated value is a rough market range and should be reviewed manually.'
          ]
        : []),
      ...(apiCertificateIssue
        ? [
            'Card name was detected, but online database lookup failed due to a local certificate issue.',
            'Online database lookup failed. Check backend HTTPS certificate settings.',
            'Please review the result manually.'
          ]
        : apiLookupFailed
          ? ['Online database lookup failed or could not confirm the exact card.', 'Please review the result manually.']
          : []),
      ...(topMatch && !hasStrongMatch ? ['Only a medium-confidence match was found. Please review the possible matches manually.'] : []),
      identityDecision.reason,
      ...(identityDecision.warnings ?? []),
      ...(preprocessing.diagnostics.blurScore < 40 ? ['Photo may be blurry. Retake with the camera held steady if detection looks wrong.'] : []),
      ...(preprocessing.diagnostics.glareScore > 0.83 ? ['Photo may have glare or very bright reflections.'] : [])
    ];
    const needsManualCrop =
      !topMatch &&
      preprocessing.diagnostics.crop?.mode === 'fallback_center' &&
      (!canSearch || !detectedDetails.cardName);
    const resultStatus: CardScanResult['status'] = needsManualCrop
      ? 'needs_manual_crop'
      : topMatch?.source === 'local_fallback_database' || fallbackMatch
        ? 'success_with_fallback'
      : hasStrongMatch
        ? 'success'
        : apiLookupFailed
          ? 'api_lookup_failed'
        : topMatch || canSearch
          ? 'needs_manual_review'
          : warnings.length
            ? 'partial'
            : 'error';
    const responseCrop = needsManualCrop && preprocessing.diagnostics.crop
      ? {
          ...preprocessing.diagnostics.crop,
          valid: false,
          confidence: Math.min(0.2, preprocessing.diagnostics.crop.confidence),
          warnings: [
            'Could not confidently detect the full card.',
            'Please adjust the crop around the whole card.',
            ...preprocessing.diagnostics.crop.warnings
          ]
        }
      : preprocessing.diagnostics.crop;
    const quality = buildScanQuality(preprocessing.diagnostics);
    const conditionEstimate = await this.conditionGradingService.analyze({
      frontImageBuffer: preprocessing.normalizedBuffer,
      backImageBuffer: input.backImageBuffer,
      frontCropValid: preprocessing.diagnostics.cropValid,
      debugMode: input.debugMode
    });

    const debugPayload: CardScanResult['debug'] = input.debugMode
      ? {
          ocrText,
          ocrDigest: this.toOcrDigest(ocrText),
          confidence: topMatch?.confidence,
          queriesUsed,
          ocr: ocrDebug,
          api: {
            query: getWinningQuery(topMatch, extracted, queriesUsed),
            responseCount: publicPossibleMatches.length,
            topResultName: publicTopMatch?.cardName,
            calls: apiCalls
          },
          pricing: {
            providerUsed: pricing.providerUsed,
            cacheStatus: pricing.cacheStatus,
            scrydexCalled: pricing.scrydexCalled,
            scrydexSkippedReason: pricing.scrydexSkippedReason,
            selectedPriceField: pricing.selectedPriceField,
            errorType: pricing.errorType,
            estimatedValue: pricing.estimatedValue
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
          },
          resultDecision: identityDecision
        }
      : undefined;

    const result: CardScanResult = {
      scanId,
      success: identityDecision.confirmedIdentity,
      status: resultStatus,
      identityStatus: identityDecision.status,
      confirmedIdentity: identityDecision.confirmedIdentity,
      needsBetterPhoto: identityDecision.needsBetterPhoto,
      pricingEligible: identityDecision.pricingEligible,
      reason: identityDecision.reason,
      identity: identityDecision,
      rawImageUrl: preprocessing.rawImageUrl,
      normalizedImageUrl: preprocessing.normalizedImageUrl,
      detectedGame: topMatch?.game ?? input.selectedGame,
      detectedDetails,
      closestMatch,
      officialMatch,
      estimatedValue: identityDecision.pricingEligible ? pricing.estimatedValue : null,
      alternatives: publicAlternatives,
      possibleMatches: publicPossibleMatches,
      needsUserConfirmation: identityDecision.needsUserConfirmation,
      matchEvidence: this.buildMatchEvidence(detectedDetails, officialMatch, numberConflict),
      quality,
      collectorNumberCandidates: ocrDebug.collectorNumberCandidates ?? [],
      chosenCollectorNumber: ocrDebug.chosenCollectorNumber ?? detectedDetails.cardNumber ?? null,
      collectorNumberConfidence: ocrDebug.collectorNumberConfidence ?? (detectedDetails.cardNumber ? 'medium' : 'low'),
      conditionEstimate,
      imageDiagnostics: preprocessing.diagnostics,
      crop: responseCrop,
      gradingPrep: undefined,
      warnings: [...warnings, ...(identityDecision.warnings ?? [])],
      detectionNotes,
      manualSearchSuggested: !topMatch || needsManualCrop || numberConflict || fallbackMatchFound,
      message: needsManualCrop
        ? 'We could not confidently detect the full card. Please adjust the crop around the card.'
        : identityDecision.status === 'identified'
          ? 'Card detection completed.'
          : identityDecision.status === 'needs_better_photo'
            ? identityDecision.reason
          : fallbackMatchFound
            ? 'Fallback match found. Please review manually.'
        : apiLookupFailed
            ? 'Card name was detected, but online database lookup failed.'
          : topMatch || canSearch
            ? 'Review needed. Possible matches were returned for manual confirmation.'
            : 'Card text could not be read clearly. Please try another photo.',
      debug: debugPayload
    };

    result.gradingPrep = this.gradingPrepService.prepare(result);

    this.log(scanId, `final extracted fields: ${JSON.stringify({
      name: detectedDetails.cardName,
      hp: detectedDetails.hp,
      cardNumber: detectedDetails.cardNumber,
      setCode: detectedDetails.setCode,
      language: detectedDetails.language,
      year: detectedDetails.year
    })}`);
    this.log(scanId, `final API matching: ${JSON.stringify({
      queryUsed: getWinningQuery(topMatch, extracted, queriesUsed),
      resultCount: publicPossibleMatches.length,
      selectedMatchName: officialMatch?.cardName,
      selectedMatchNumber: officialMatch?.cardNumber,
      selectedMatchSetId: officialMatch?.setCode,
      selectedMatchSetName: officialMatch?.setSeries ?? officialMatch?.setOrSeries,
      selectedMatchRarity: officialMatch?.rarity,
      extractedCardNumber: detectedDetails.cardNumber,
      selectedApiNumber: conflictingApiNumber ?? publicTopMatch?.cardNumber,
      numberConflict,
      finalDisplayedCardNumber: officialMatch?.cardNumber,
      estimatedValue: result.estimatedValue,
      confidenceScore: officialMatch?.confidenceScore,
      confidenceLabel: officialMatch?.confidenceLabel,
      status: result.status,
      identityStatus: result.identityStatus,
      confirmedIdentity: result.confirmedIdentity,
      pricingEligible: result.pricingEligible,
      source: officialMatch?.source,
      finalSelectedSource: {
        extractedName: detectedDetails.cardName,
        extractedCardNumber: detectedDetails.cardNumber,
        extractedSetCode: detectedDetails.setCode,
        apiExactMatchFound: hasStrongMatch,
        conflictingApiMatches: numberConflict ? 1 : 0,
        fallbackMatchFound,
        selectedSource: officialMatch?.source,
        officialCardName: officialMatch?.cardName,
        officialCardNumber: officialMatch?.cardNumber,
        officialSetSeries: officialMatch?.setSeries ?? officialMatch?.setOrSeries,
        officialRarity: officialMatch?.rarity,
        estimatedValue: result.estimatedValue,
        status: result.status
      }
    })}`);

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
      year?: string;
    };
    const setCode = normalizePokemonSetCode(cleanField(extractedDetails.setCode));
    const setSeries = inferPokemonSetSeries(setCode);

    return {
      cardName: cleanField(extractedDetails.name ?? topMatch?.name) ?? null,
      cardNumber: cleanField(extractedDetails.cardNumber) ?? null,
      language: normalizeLanguage(extractedDetails.language ?? topMatch?.language),
      setCode,
      setSeries,
      setOrSeries: setSeries ?? setCode,
      hp: cleanField(extractedDetails.hp) ?? null,
      rarity: cleanField(extractedDetails.rarity ?? topMatch?.rarity) ?? null,
      year: cleanField(extractedDetails.year) ?? null
    };
  }

  private toPublicMatch(candidate: CardCandidate): PublicCardMatch {
    const setSeries = candidate.setName ?? inferPokemonSetSeries(normalizePokemonSetCode(candidate.setCode)) ?? candidate.setCode;
    return {
      id: candidate.id,
      source: candidate.source,
      game: candidate.game,
      cardName: candidate.name,
      cardNumber: candidate.cardNumber,
      language: cleanLanguage(candidate.language),
      setCode: candidate.setCode,
      setSeries,
      setOrSeries: setSeries,
      rarity: candidate.rarity,
      imageUrl: candidate.imageUrl,
      confidenceLabel: (candidate.confidence ?? 0) >= 0.85 ? 'Strong match found' : (candidate.confidence ?? 0) >= 0.65 ? 'Review needed' : 'Low confidence',
      confidenceScore: candidate.confidence,
      estimatedValue: candidate.prices
    };
  }

  private buildOcrFallbackMatch(detected: PublicDetectedDetails, selectedGame?: string): PublicCardMatch | null {
    if (!detected.cardName && !detected.cardNumber && !detected.setCode) return null;
    return {
      id: `ocr-fallback-${detected.cardName ?? detected.cardNumber ?? 'card'}`,
      source: 'ocr_fallback',
      game: selectedGame ?? 'unknown',
      cardName: detected.cardName ?? 'Review needed',
      cardNumber: detected.cardNumber ?? undefined,
      language: detected.language ?? undefined,
      setCode: detected.setCode ?? undefined,
      setSeries: detected.setSeries ?? detected.setOrSeries ?? detected.setCode ?? undefined,
      setOrSeries: detected.setSeries ?? detected.setOrSeries ?? detected.setCode ?? undefined,
      rarity: detected.rarity ?? inferPromoRarityFromSetCode(detected.setCode) ?? undefined,
      confidenceLabel: 'Review needed',
      confidenceScore: 0.5
    };
  }

  private toFallbackMatch(card: PokemonFallbackCard, language: string): PublicCardMatch {
    return {
      id: `local-fallback-${card.normalizedName}-${card.cardNumber}-${card.normalizedSetCode}`,
      source: 'local_fallback_database',
      game: card.game,
      cardName: card.name,
      cardNumber: card.cardNumber,
      language,
      setCode: card.setCode,
      setName: card.setName,
      setSeries: card.setSeries,
      setOrSeries: card.setSeries,
      rarity: card.rarity,
      hp: card.hp,
      confidenceLabel: 'Fallback match found',
      confidenceScore: 0.85,
      tcgplayerProductId: card.tcgplayerProductId,
      estimatedValue: env.ENABLE_FALLBACK_PRICE_ESTIMATES ? card.estimatedValue : undefined
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

  private buildIdentityDecision(input: {
    hasStrongMatch: boolean;
    topMatch?: CardCandidate;
    detectedDetails: PublicDetectedDetails;
    numberConflict: boolean;
    canSearch: boolean;
    warnings: string[];
    ocrDebug: OcrDebugInfo;
  }): IdentityResultDecision {
    const confidence = input.topMatch?.confidence ?? 0;
    const hasCollectorEvidence = Boolean(input.detectedDetails.cardNumber || input.detectedDetails.setCode);
    const collectorRecapture = getCollectorRecaptureReason(input.ocrDebug);
    const warnings = [...input.warnings];

    if (input.hasStrongMatch && hasCollectorEvidence) {
      return {
        status: 'identified',
        confirmedIdentity: true,
        needsUserConfirmation: false,
        needsBetterPhoto: false,
        pricingEligible: true,
        confidence,
        reason: 'Strong match confirmed by collector number or set evidence.',
        warnings
      };
    }

    if (input.hasStrongMatch && confidence >= 0.95) {
      return {
        status: 'identified',
        confirmedIdentity: true,
        needsUserConfirmation: false,
        needsBetterPhoto: false,
        pricingEligible: true,
        confidence,
        reason: 'Strong high-confidence match found.',
        warnings
      };
    }

    if (input.numberConflict) {
      return {
        status: 'manual_review',
        confirmedIdentity: false,
        needsUserConfirmation: true,
        needsBetterPhoto: false,
        pricingEligible: false,
        confidence,
        reason: 'Database match conflicts with the scanned collector number, so identity is not confirmed.',
        warnings: [...warnings, 'Review manually before using this card identity.']
      };
    }

    if (!input.detectedDetails.cardNumber && collectorRecapture) {
      return {
        status: 'needs_better_photo',
        confirmedIdentity: false,
        needsUserConfirmation: true,
        needsBetterPhoto: true,
        pricingEligible: false,
        confidence,
        reason: collectorRecapture,
        warnings: [...warnings, collectorRecapture]
      };
    }

    if (input.topMatch && confidence >= 0.65) {
      return {
        status: 'needs_confirmation',
        confirmedIdentity: false,
        needsUserConfirmation: true,
        needsBetterPhoto: false,
        pricingEligible: false,
        confidence,
        reason: 'A likely match was found, but the collector number or set evidence is not strong enough to confirm identity.',
        warnings
      };
    }

    if (input.topMatch || input.detectedDetails.cardName || input.canSearch) {
      return {
        status: 'manual_review',
        confirmedIdentity: false,
        needsUserConfirmation: true,
        needsBetterPhoto: false,
        pricingEligible: false,
        confidence,
        reason: 'Only a weak best-guess match is available. Confirm manually before using pricing or grading metadata.',
        warnings
      };
    }

    return {
      status: 'no_match',
      confirmedIdentity: false,
      needsUserConfirmation: true,
      needsBetterPhoto: false,
      pricingEligible: false,
      confidence,
      reason: 'No reliable card identity could be selected from the scan.',
      warnings
    };
  }

  private buildMatchEvidence(detected: PublicDetectedDetails, official?: PublicCardMatch | null, numberConflict = false): MatchEvidence {
    const nameMatched = Boolean(detected.cardName && official?.cardName && normalizeNameForCompare(official.cardName).includes(normalizeNameForCompare(detected.cardName)));
    const numberMatched = Boolean(detected.cardNumber && official?.cardNumber && pokemonCardNumbersMatch(official.cardNumber, detected.cardNumber));
    const setMatched = Boolean(detected.setCode && (normalizeSetForCompare(official?.setCode) === normalizeSetForCompare(detected.setCode) || normalizeSetForCompare(official?.setSeries).includes(normalizeSetForCompare(detected.setCode))));
    const missingFields = [
      !detected.cardName && 'card name',
      !detected.cardNumber && 'collector number',
      !detected.setCode && 'set code',
      !official?.rarity && 'rarity',
      !official?.estimatedValue && 'price'
    ].filter(Boolean) as string[];
    const uncertainFields = [
      numberConflict && 'collector number conflict',
      official?.source === 'ocr_fallback' && 'database confirmation',
      official?.source === 'local_fallback_database' && 'official API confirmation',
      !numberMatched && detected.cardNumber && official?.cardNumber && 'collector number'
    ].filter(Boolean) as string[];

    return {
      matchedCardLabel: [official?.cardName ?? detected.cardName, official?.cardNumber ?? detected.cardNumber, official?.setCode ?? detected.setCode].filter(Boolean).join(' - '),
      nameMatched,
      numberMatched,
      setMatched,
      source: official?.source,
      confidenceScore: official?.confidenceScore,
      confidenceLabel: official?.confidenceLabel,
      missingFields,
      uncertainFields,
      reasons: [
        nameMatched ? `Name matched: ${detected.cardName}` : detected.cardName ? `Name detected: ${detected.cardName}` : 'Name was not confidently detected.',
        numberMatched ? `Collector number matched: ${detected.cardNumber}` : detected.cardNumber ? `Collector number detected: ${detected.cardNumber}` : 'Collector number was not confidently detected.',
        setMatched ? `Set matched: ${detected.setCode}` : detected.setCode ? `Set code detected: ${detected.setCode}` : 'Set code was not confidently detected.',
        official?.source ? `Source used: ${official.source}` : 'No database source was selected.'
      ]
    };
  }
}

function getCollectorRecaptureReason(ocrDebug: OcrDebugInfo): string | undefined {
  const qualities = ocrDebug.collectorQuality ?? [];
  const fusedReadable = qualities.some((quality) => quality.roi === 'collectorFused' && quality.readable);
  if (fusedReadable) return undefined;

  const recapture = qualities.find((quality) =>
    quality.recaptureRecommended &&
    (quality.roi === 'collectorClassic' || quality.roi === 'collectorPromo' || quality.roi === 'collectorRight')
  );
  if (!recapture) return undefined;

  const reason = recapture.reason.toLowerCase();
  if (reason.includes('glare') || recapture.glareRatio > 0.06) {
    return 'Collector number area appears glared or overexposed. Please retake the photo closer and clearer.';
  }
  if (reason.includes('blurry') || recapture.blurScore < 15) {
    return 'Collector number area appears blurry. Please retake the photo closer and sharper.';
  }
  if (reason.includes('small') || recapture.width < 140 || recapture.height < 42) {
    return 'Collector number area is too small to read. Please move closer while keeping the full card visible.';
  }
  if (reason.includes('contrast')) {
    return 'Collector number area has low contrast. Please retake with brighter, even lighting.';
  }
  return 'Collector number area could not be read clearly. Please retake the photo closer and clearer.';
}

function buildScanQuality(diagnostics: CardScanResult['imageDiagnostics']): ScanQuality {
  const warnings: string[] = [];
  const checks: ScanQuality['checks'] = {};
  let score = 100;

  if ((diagnostics?.blurScore ?? 100) < 40) {
    score -= 25;
    warnings.push('Image may be blurry. Keep the phone steady and make the card text sharp.');
    checks.blur = 'warning';
  } else {
    checks.blur = 'good';
  }

  if ((diagnostics?.glareScore ?? 0) > 0.83) {
    score -= 20;
    warnings.push('Bright glare or reflection may reduce OCR accuracy.');
    checks.glare = 'warning';
  } else {
    checks.glare = 'good';
  }

  if (diagnostics?.cropValidation && !diagnostics.cropValidation.valid) {
    score -= 25;
    warnings.push('The card crop was weak. Place the full card inside the guide border.');
    checks.cropSize = 'warning';
  } else {
    checks.cropSize = 'good';
  }

  if ((diagnostics?.cropValidation?.cropAreaRatio ?? 1) < 0.25) {
    score -= 15;
    warnings.push('The card appears small in the frame. Move closer while keeping the whole card visible.');
  }

  if ((diagnostics?.glareScore ?? 0.5) < 0.18) {
    score -= 10;
    warnings.push('The image may be too dark. Use brighter, even lighting.');
    checks.darkness = 'warning';
  } else {
    checks.darkness = 'good';
  }

  if (diagnostics?.cropValid === false) {
    score -= 15;
    warnings.push('The card angle or boundary was uncertain. A straighter overhead photo will help.');
    checks.perspective = 'warning';
  } else {
    checks.perspective = 'good';
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clamped,
    warnings,
    recommendation: clamped >= 75 ? 'Good to scan' : clamped >= 50 ? 'Scan anyway' : 'Retake recommended',
    checks
  };
}

function cleanField(value?: string): string | undefined {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function normalizePokemonSetCode(value?: string): string | null {
  if (!value) return null;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (compact.startsWith('SVP')) return 'SVP EN';
  if (compact.startsWith('SWSH')) return 'SWSH';
  if (compact === 'BASESET' || compact === 'BASE1') return 'Base Set';
  return value.toUpperCase().replace(/\s+/g, ' ').trim();
}

function inferPokemonSetSeries(setCode?: string | null): string | null {
  if (!setCode) return null;
  const compact = setCode.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (compact.startsWith('SVP')) return 'Scarlet & Violet Promo';
  if (compact.startsWith('SWSH')) return 'Sword & Shield Promo';
  if (compact === 'BASESET' || compact === 'BASE1') return 'Base Set';
  return null;
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

  const letters = name.match(/[A-Za-z]/g)?.length ?? 0;
  const symbols = name.match(/[^A-Za-z0-9\s.'’:-]/g)?.length ?? 0;
  if (!name || letters < 3 || symbols > letters) return undefined;
  return normalizeKnownPokemonName(name) ?? name.trim();
}

function normalizeCollectorNumber(value?: string, setCode?: string): string | undefined {
  if (!value || value === 'Not found') return undefined;
  const source = String(value);
  if (/^\d{1,3}$/.test(source.trim()) && setCode && /^(SVP EN|SVP|SWSH)$/i.test(setCode.trim())) {
    return source.trim();
  }
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

function hasCertificateLookupFailure(apiCalls: ApiSearchDebugEntry[]): boolean {
  return apiCalls.some((call) => /certificate|first certificate|unable to verify|use-system-ca/i.test(call.error ?? ''));
}

function hasNumberConflict(extracted: Record<string, unknown>, candidate?: CardCandidate): boolean {
  const ocrNumber = normalizePokemonCardNumber(String((extracted as { cardNumber?: string }).cardNumber ?? ''));
  const apiNumber = normalizePokemonCardNumber(candidate?.cardNumber ?? '');
  return Boolean(ocrNumber && apiNumber && !pokemonCardNumbersMatch(ocrNumber, apiNumber));
}

function normalizeCardNumber(value?: string): string {
  return normalizePokemonCardNumber(cleanField(value)) ?? '';
}

function normalizeNameForCompare(value?: string | null): string {
  return cleanField(value ?? undefined)?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() ?? '';
}

function normalizeSetForCompare(value?: string | null): string {
  const compact = cleanField(value ?? undefined)?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';
  if (compact.startsWith('svpen') || compact === 'svp' || compact.includes('scarletvioletpromo')) return 'svp';
  if (compact.startsWith('swsh') || compact.includes('swordshieldpromo')) return 'swsh';
  if (compact === 'baseset' || compact === 'base1') return 'base1';
  return compact;
}

function inferPromoRarityFromSetCode(setCode?: string | null): string | null {
  if (!setCode) return null;
  const compact = setCode.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (compact.startsWith('SVP') || compact.startsWith('SWSH')) return 'Promo';
  return null;
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
    if (!details.name && !details.cardNumber && !details.setCode && details.attackNameHint && isValidSearchName(details.attackNameHint)) return true;
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
