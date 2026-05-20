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
  imageUrl?: string;
  prices?: {
    market?: number;
    low?: number;
    mid?: number;
    high?: number;
    currency?: string;
  };
  confidence?: number;
  confidenceReasons?: string[];
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
};

export type PublicCardMatch = {
  id: string;
  source: string;
  game: string;
  cardName: string;
  cardNumber?: string;
  language?: string;
  setOrSeries?: string;
  rarity?: string;
  imageUrl?: string;
  estimatedValue?: {
    market?: number;
    low?: number;
    mid?: number;
    high?: number;
    currency?: string;
  };
};

export type CardDetails = CardCandidate & {
  description?: string;
  metadata?: Record<string, unknown>;
};

export type ExtractedCardDetails = {
  name?: string;
  cardNumber?: string;
  setCode?: string;
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
  regionImages?: Partial<Record<'name' | 'attack' | 'bottom', string>>;
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
  status?: 'success' | 'partial' | 'error' | 'needs_manual_crop' | 'needs_manual_review';
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
  rawImagePath?: string;
  normalizedImagePath?: string;
  backImagePath?: string;
  alternativesFull?: PublicCardMatch[];
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

export type OcrRegionName = 'full' | 'title' | 'footer' | 'number' | 'name' | 'hp' | 'attack' | 'bottom';

export type OcrRegionResult = {
  region: OcrRegionName;
  text: string;
  confidence: number;
};
