export type SupportedGame =
  | 'pokemon'
  | 'magic'
  | 'yugioh'
  | 'lorcana'
  | 'onepiece'
  | 'generic';

export type CardCandidate = {
  id: string;
  source: string;
  game: string;
  name: string;
  setName?: string;
  setCode?: string;
  cardNumber?: string;
  rarity?: string;
  language?: string;
  hp?: string;
  imageUrl?: string;
  prices?: {
    amount?: number;
    min?: number;
    max?: number;
    market?: number;
    low?: number;
    mid?: number;
    high?: number;
    currency?: string;
    source?: string;
    label?: string;
    confidence?: string;
    note?: string;
  };
  confidence?: number;
  confidenceReasons?: string[];
  releaseDate?: string;
};

export type PublicDetectedDetails = {
  cardName?: string | null;
  cardNumber?: string | null;
  language?: string | null;
  setCode?: string | null;
  setSeries?: string | null;
  setOrSeries?: string | null;
  hp?: string | null;
  rarity?: string | null;
  year?: string | null;
};

export type PublicCardMatch = {
  id: string;
  source: string;
  game: string;
  cardName: string;
  cardNumber?: string;
  language?: string;
  setName?: string;
  setSeries?: string;
  setOrSeries?: string;
  hp?: string;
  rarity?: string;
  imageUrl?: string;
  confidenceLabel?: 'Strong match found' | 'Strong match' | 'Fallback match found' | 'Review needed' | 'Low confidence';
  confidenceScore?: number;
  setCode?: string;
  tcgplayerProductId?: string;
  estimatedValue?: {
    amount?: number;
    min?: number;
    max?: number;
    market?: number;
    low?: number;
    mid?: number;
    high?: number;
    currency?: string;
    source?: string;
    label?: string;
    confidence?: string;
    note?: string;
  };
};

export type IdentityResultStatus = 'identified' | 'needs_confirmation' | 'needs_better_photo' | 'manual_review' | 'no_match';

export type IdentityResultDecision = {
  status: IdentityResultStatus;
  confirmedIdentity: boolean;
  needsUserConfirmation: boolean;
  needsBetterPhoto: boolean;
  pricingEligible: boolean;
  reason: string;
  warnings?: string[];
  confidence?: number;
};

export type CardDetails = CardCandidate & {
  description?: string;
  metadata?: Record<string, unknown>;
};

export type ExtractedCardDetails = {
  name?: string;
  cardNumber?: string;
  localId?: string;
  printedNumber?: string;
  collectorNumber?: string;
  printedTotal?: string;
  setCode?: string;
  setName?: string;
  language?: string;
  rarity?: string;
  hp?: string;
  damage?: string;
  year?: string;
  attackNameHint?: string;
};

export type ApiSearchDebugEntry = {
  source: string;
  searchType: 'number' | 'name' | 'attack';
  query: string;
  endpoint: string;
  status?: number;
  resultCount?: number;
  topMatchName?: string;
  error?: string;
  errorType?: string;
};

export type OcrDebugInfo = {
  regionTexts?: Partial<Record<OcrRegionName, string>>;
  rawRegionTexts?: Partial<Record<OcrRegionName, string>>;
  cleanedText?: string;
  extracted?: ExtractedCardDetails;
  attempts?: OcrAttemptDebugInfo[];
  selectedAttemptName?: string;
  usefulnessScore?: number;
  weakResultReason?: string;
  rejectedCardNameReason?: string;
  regionImages?: Partial<Record<'fullCard' | 'name' | 'hp' | 'attack' | 'attackDamage' | 'bottom' | 'collector' | 'collectorRight' | 'collectorClassic' | 'collectorPromo', string>>;
  collectorNumberCandidates?: CollectorNumberCandidate[];
  chosenCollectorNumber?: string | null;
  collectorNumberConfidence?: 'low' | 'medium' | 'high';
  cropReports?: OcrCropDebugInfo[];
  collectorQuality?: CollectorOcrQualityInfo[];
};

export type OcrAttemptDebugInfo = {
  name: string;
  cropWidth: number;
  cropHeight: number;
  rawText: string;
  cleanedText: string;
  extracted: ExtractedCardDetails;
  usefulnessScore: number;
  averageConfidence: number;
  rejectedNameReason?: string;
  evidenceAttempts?: OcrEvidenceAttemptDebugInfo[];
  selectedEvidence?: Partial<Record<'hp' | 'bottom' | 'collector' | 'collectorRight' | 'collectorClassic' | 'collectorPromo' | 'collectorFused', string>>;
  cropReports?: OcrCropDebugInfo[];
  collectorQuality?: CollectorOcrQualityInfo[];
};

export type OcrEvidenceAttemptDebugInfo = {
  region: 'hp' | 'bottom' | 'collector' | 'collectorRight' | 'collectorClassic' | 'collectorPromo' | 'collectorFused';
  variant: string;
  rawText: string;
  cleanedText: string;
  confidence: number;
  score: number;
  reason: string;
  parsedLocalId?: string;
  parsedPrintedNumber?: string;
  parsedCollectorNumber?: string;
  parsedSetCode?: string;
  parsedSetName?: string;
  parsedHp?: string;
  imagePath?: string;
  selected?: boolean;
};

export type OcrCropDebugInfo = {
  attemptName: string;
  region: OcrRegionName;
  percent?: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  pixels?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  dimensions?: {
    width: number;
    height: number;
  };
};

export type CollectorOcrQualityInfo = {
  attemptName: string;
  roi: 'collector' | 'collectorRight' | 'collectorClassic' | 'collectorPromo' | 'collectorFused';
  width: number;
  height: number;
  blurScore: number;
  glareRatio: number;
  contrastScore: number;
  edgeDensityScore?: number;
  selectedEvidence?: string;
  readable: boolean;
  recaptureRecommended: boolean;
  reason: string;
};

export type CardMatchDebugInfo = {
  id: string;
  source: string;
  game: string;
  cardName: string;
  cardNumber?: string;
  setOrSeries?: string;
  rarity?: string;
  imageUrl?: string;
  confidence?: number;
  confidenceReasons: string[];
};

export type CardScanResult = {
  scanId: string;
  rawImageUrl: string;
  normalizedImageUrl?: string;
  detectedGame?: string;
  success?: boolean;
  status?: 'success' | 'success_with_fallback' | 'partial' | 'error' | 'needs_manual_crop' | 'needs_manual_review' | 'api_lookup_failed';
  identityStatus?: IdentityResultStatus;
  confirmedIdentity?: boolean;
  userConfirmed?: boolean;
  needsBetterPhoto?: boolean;
  pricingEligible?: boolean;
  reason?: string;
  identity?: IdentityResultDecision;
  detectedDetails: PublicDetectedDetails;
  closestMatch?: PublicCardMatch;
  officialMatch?: PublicCardMatch | null;
  estimatedValue?: PublicCardMatch['estimatedValue'] | null;
  alternatives: PublicCardMatch[];
  possibleMatches?: PublicCardMatch[];
  needsUserConfirmation: boolean;
  message?: string;
  warnings?: string[];
  detectionNotes?: string[];
  manualSearchSuggested?: boolean;
  matchEvidence?: MatchEvidence;
  quality?: ScanQuality;
  collectorNumberCandidates?: CollectorNumberCandidate[];
  chosenCollectorNumber?: string | null;
  collectorNumberConfidence?: 'low' | 'medium' | 'high';
  correctedFields?: CorrectedCardFields;
  conditionEstimate?: ConditionGradeResult;
  crop?: {
    mode: 'auto' | 'fallback_center' | 'manual' | 'full_image';
    valid: boolean;
    confidence: number;
    coordinates?: {
      x: number;
      y: number;
      width: number;
      height: number;
      rotation?: number;
    };
    corners?: Array<{ x: number; y: number }>;
    warnings: string[];
  };
  debug?: {
    ocrText?: string;
    ocrDigest?: string;
    confidence?: number;
    queriesUsed?: string[];
    ocr?: OcrDebugInfo;
    api?: {
      query?: string;
      responseCount?: number;
      topResultName?: string;
      calls?: ApiSearchDebugEntry[];
    };
    pricing?: {
      providerUsed?: string;
      cacheStatus?: 'hit' | 'miss' | 'skipped';
      scrydexCalled?: boolean;
      scrydexSkippedReason?: string;
      selectedPriceField?: string;
      errorType?: string;
      estimatedValue?: PublicCardMatch['estimatedValue'] | null;
    };
    identification?: {
      selectedGame?: string;
      selectedLanguage?: string;
      uploadedImageUrl?: string;
      normalizedImageUrl?: string;
      rawOcrText?: string;
      cleanedOcrText?: string;
      extractedFields: ExtractedCardDetails;
      queriesUsed: string[];
      topMatches: CardMatchDebugInfo[];
    };
    resultDecision?: IdentityResultDecision;
  };
  imageDiagnostics?: {
    blurScore?: number;
    glareScore?: number;
    cropValid: boolean;
    normalizedWidth?: number;
    normalizedHeight?: number;
    originalWidth?: number;
    originalHeight?: number;
    cropValidation?: {
      cropWidth: number;
      cropHeight: number;
      cropArea: number;
      originalArea: number;
      cropAreaRatio: number;
      valid: boolean;
      reasons: string[];
    };
  };
  gradingPrep?: {
    status: 'ready' | 'needs-review';
    checklist: string[];
    futureEmbeddingKey?: string;
  };
};

export type CardScanRecord = CardScanResult & {
  createdAt: string;
  selectedGame?: string;
  selectedLanguage?: string;
  confirmedCardId?: string;
  confirmedSource?: string;
  confirmedAt?: string;
  manuallyCorrected?: boolean;
  rawImagePath?: string;
  normalizedImagePath?: string;
  backImagePath?: string;
  alternativesFull?: PublicCardMatch[];
};

export type CollectorNumberCandidate = {
  value: string;
  localId?: string;
  printedNumber?: string;
  printedTotal?: string;
  setCode?: string;
  setName?: string;
  source: string;
  votes: number;
  confidence: 'low' | 'medium' | 'high';
  rawText?: string;
};

export type MatchEvidence = {
  matchedCardLabel?: string;
  nameMatched: boolean;
  numberMatched: boolean;
  setMatched: boolean;
  source?: string;
  confidenceScore?: number;
  confidenceLabel?: string;
  missingFields: string[];
  uncertainFields: string[];
  reasons: string[];
};

export type ScanQuality = {
  score: number;
  warnings: string[];
  recommendation: 'Good to scan' | 'Retake recommended' | 'Scan anyway';
  checks: {
    blur?: 'good' | 'warning';
    glare?: 'good' | 'warning';
    cropSize?: 'good' | 'warning';
    darkness?: 'good' | 'warning';
    perspective?: 'good' | 'warning';
  };
};

export type CorrectedCardFields = {
  cardName?: string;
  cardNumber?: string;
  setCode?: string;
  language?: string;
  manuallyCorrected?: boolean;
};

export type CorrectCardInput = CorrectedCardFields & {
  scanId: string;
};

export type ConditionCategoryResult = {
  score: number | null;
  notes: string[];
  frontScore: number | null;
  backScore: number | null;
};

export type WhiteningCategoryResult = {
  score: number | null;
  notes: string[];
  backScore: number | null;
};

export type ConditionGradeResult = {
  gradeAvailable: boolean;
  mode: 'full_estimate' | 'partial_estimate' | 'low_confidence_estimate' | 'unavailable';
  estimatedGrade: number | null;
  photoQualityScore?: number;
  gradingConfidence?: 'low' | 'medium' | 'high';
  conditionScore?: number | null;
  gradeLabel: string;
  confidence: 'low' | 'medium' | 'high';
  disclaimer: string;
  summary: string;
  message?: string;
  breakdown: {
    centering: ConditionCategoryResult;
    corners: ConditionCategoryResult & {
      cornerDetails: {
        frontTopLeft?: string;
        frontTopRight?: string;
        frontBottomLeft?: string;
        frontBottomRight?: string;
        backTopLeft?: string;
        backTopRight?: string;
        backBottomLeft?: string;
        backBottomRight?: string;
      };
    };
    edges: ConditionCategoryResult;
    surface: ConditionCategoryResult;
    whitening: WhiteningCategoryResult;
    printQuality: {
      score: number | null;
      notes: string[];
    };
  };
  capRulesApplied: string[];
  warnings: string[];
  retakeTips: string[];
  debug?: {
    frontQualityScore?: number;
    backQualityScore?: number;
    frontCardRectangle?: {
      x: number;
      y: number;
      width: number;
      height: number;
      corners: Array<{ x: number; y: number }>;
    };
    backCardRectangle?: {
      x: number;
      y: number;
      width: number;
      height: number;
      corners: Array<{ x: number; y: number }>;
    };
    centeringRatios?: {
      frontLeftRight?: string;
      frontTopBottom?: string;
      backLeftRight?: string;
      backTopBottom?: string;
      front?: CenteringDebugInfo;
      back?: CenteringDebugInfo;
    };
    blurScores?: {
      front: number;
      back?: number;
    };
    glareScores?: {
      front: number;
      back?: number;
    };
    whiteningMetrics?: Record<string, unknown>;
    edgeMetrics?: Record<string, unknown>;
    cornerMetrics?: Record<string, unknown>;
    surfaceMetrics?: Record<string, unknown>;
    conditionScoreBeforeCaps?: number | null;
    conditionScoreAfterCaps?: number | null;
    confidencePenaltyReasons?: string[];
    actualDamageDetected?: boolean;
    capsApplied?: string[];
    blurOrCropAffectedConfidenceOnly?: boolean;
    finalFormula?: string;
  };
};

export type CenteringDebugInfo = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  horizontalBalance: number;
  verticalBalance: number;
};

export interface CardApiAdapter {
  game: SupportedGame;
  source: string;
  searchByName(query: string, language?: string, debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]>;
  searchByNumber(cardNumber: string, setCode?: string, language?: string, debugCollector?: ApiSearchDebugEntry[]): Promise<CardCandidate[]>;
  getCardById(id: string, language?: string): Promise<CardDetails | null>;
}

export type DetectCardInput = {
  imageBuffer: Buffer;
  filename: string;
  mimeType: string;
  selectedGame?: string;
  selectedLanguage?: string;
  debugMode?: boolean;
  backImageBuffer?: Buffer;
  manualCrop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
  };
};

export type OcrRegionName = 'full' | 'title' | 'footer' | 'number' | 'name' | 'hp' | 'attack' | 'attackDamage' | 'bottom' | 'collector' | 'collectorRight' | 'collectorClassic' | 'collectorPromo' | 'collectorFused';

export type OcrRegionResult = {
  region: OcrRegionName;
  text: string;
  confidence: number;
};
