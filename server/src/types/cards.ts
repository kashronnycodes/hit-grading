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
};

export type PublicDetectedDetails = {
  cardName?: string;
  cardNumber?: string;
  language?: string;
  setOrSeries?: string;
  rarity?: string;
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
};

export type OcrDebugInfo = {
  regionTexts?: Partial<Record<OcrRegionName, string>>;
  rejectedCardNameReason?: string;
  regionImages?: Partial<Record<'name' | 'attack' | 'bottom', string>>;
};

export type CardScanResult = {
  scanId: string;
  rawImageUrl: string;
  normalizedImageUrl?: string;
  detectedGame?: string;
  status?: 'success' | 'partial' | 'error';
  detectedDetails: PublicDetectedDetails;
  closestMatch?: PublicCardMatch;
  alternatives: PublicCardMatch[];
  needsUserConfirmation: boolean;
  message?: string;
  warnings?: string[];
  manualSearchSuggested?: boolean;
  debug?: {
    ocrText?: string;
    ocrDigest?: string;
    confidence?: number;
    queriesUsed?: string[];
    ocr?: OcrDebugInfo;
  };
  imageDiagnostics?: {
    blurScore?: number;
    glareScore?: number;
    cropValid: boolean;
    normalizedWidth?: number;
    normalizedHeight?: number;
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
  alternativesFull?: PublicCardMatch[];
};

export interface CardApiAdapter {
  game: SupportedGame;
  source: string;
  searchByName(query: string, language?: string): Promise<CardCandidate[]>;
  searchByNumber(cardNumber: string, setCode?: string, language?: string): Promise<CardCandidate[]>;
  getCardById(id: string, language?: string): Promise<CardDetails | null>;
}

export type DetectCardInput = {
  imageBuffer: Buffer;
  filename: string;
  mimeType: string;
  selectedGame?: string;
  selectedLanguage?: string;
  backImageBuffer?: Buffer;
  manualCrop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type OcrRegionName = 'full' | 'title' | 'footer' | 'number' | 'name' | 'hp' | 'attack' | 'bottom';

export type OcrRegionResult = {
  region: OcrRegionName;
  text: string;
  confidence: number;
};
