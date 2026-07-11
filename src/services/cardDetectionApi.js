export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const USE_MOCK_SCAN = import.meta.env.VITE_USE_MOCK_SCAN === 'true';

const MOCK_CANDIDATES = [
  {
    id: 'mock-victini-208',
    source: 'mock_frontend',
    game: 'Pokemon',
    cardName: 'Victini',
    cardNumber: '208',
    language: 'English',
    setCode: 'SVP EN',
    setSeries: 'Scarlet & Violet Promo',
    rarity: 'Promo',
    imageUrl: '',
    confidence: 0.94
  },
  {
    id: 'mock-charizard-4-102',
    source: 'mock_frontend',
    game: 'Pokemon',
    cardName: 'Charizard',
    cardNumber: '4/102',
    language: 'English',
    setCode: 'base1',
    setSeries: 'Base Set',
    rarity: 'Rare Holo',
    imageUrl: '',
    confidence: 0.72
  },
  {
    id: 'mock-pikachu-87-130',
    source: 'mock_frontend',
    game: 'Pokemon',
    cardName: 'Pikachu',
    cardNumber: '87/130',
    language: 'English',
    setCode: 'base2',
    setSeries: 'Base Set 2',
    rarity: 'Common',
    imageUrl: '',
    confidence: 0.64
  }
];

function getMockScanState() {
  if (typeof window === 'undefined') return import.meta.env.VITE_MOCK_SCAN_STATE || 'identified';
  return new URLSearchParams(window.location.search).get('mockState') || import.meta.env.VITE_MOCK_SCAN_STATE || 'identified';
}

function delay(ms = 500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMockScanResult({ selectedGame, selectedLanguage, state }) {
  const normalizedState = ['identified', 'needs_better_photo', 'needs_confirmation', 'userConfirmed'].includes(state)
    ? state
    : 'identified';
  const primary = MOCK_CANDIDATES[0];
  const possibleMatches = MOCK_CANDIDATES;
  const confirmed = normalizedState === 'identified' || normalizedState === 'userConfirmed';
  const needsBetterPhoto = normalizedState === 'needs_better_photo';
  const needsConfirmation = normalizedState === 'needs_confirmation';
  const userConfirmed = normalizedState === 'userConfirmed';

  return {
    scanId: `mock-${normalizedState}-${Date.now()}`,
    success: true,
    status: needsBetterPhoto ? 'needs_manual_review' : 'success',
    identityStatus: confirmed ? 'identified' : needsBetterPhoto ? 'needs_better_photo' : 'needs_confirmation',
    confirmedIdentity: confirmed,
    userConfirmed,
    needsUserConfirmation: needsConfirmation,
    needsBetterPhoto,
    pricingEligible: confirmed,
    reason: userConfirmed
      ? 'Mock/dev only: card identity was manually confirmed by the user.'
      : confirmed
        ? 'Mock/dev only: sample card identity is confirmed for frontend testing.'
        : needsBetterPhoto
          ? 'Mock/dev only: collector number area appears blurry or glared. Retake photo recommended.'
          : 'Mock/dev only: possible card match needs user confirmation.',
    detectedDetails: {
      cardName: primary.cardName,
      cardNumber: primary.cardNumber,
      language: selectedLanguage || primary.language,
      setCode: primary.setCode,
      setSeries: primary.setSeries,
      rarity: primary.rarity,
      hp: '80',
      year: '2025'
    },
    officialMatch: confirmed ? {
      ...primary,
      confidenceLabel: userConfirmed ? 'User confirmed' : 'Strong match found',
      confidenceScore: 0.94,
      source: userConfirmed ? 'user_confirmed_mock' : 'mock_frontend'
    } : null,
    closestMatch: confirmed ? primary : possibleMatches[needsBetterPhoto ? 1 : 2],
    possibleMatches,
    alternatives: possibleMatches.slice(1),
    estimatedValue: confirmed ? {
      amount: null,
      min: 10,
      max: 20,
      currency: 'USD',
      label: '$10-$20 mock estimate',
      source: 'mock_frontend',
      confidence: 'mock'
    } : null,
    quality: {
      score: needsBetterPhoto ? 42 : 86,
      recommendation: needsBetterPhoto ? 'Retake recommended' : 'Good to scan',
      warnings: needsBetterPhoto ? ['Mock/dev only: collector number crop is blurry.'] : []
    },
    matchEvidence: {
      matchedCardLabel: `${primary.cardName} - ${primary.cardNumber} - ${primary.setCode}`,
      confidenceScore: confirmed ? 0.94 : needsBetterPhoto ? 0.45 : 0.62,
      nameMatched: true,
      numberMatched: confirmed,
      setMatched: confirmed,
      missingFields: confirmed ? [] : ['collector number confirmation'],
      uncertainFields: confirmed ? [] : ['exact card identity']
    },
    conditionEstimate: {
      gradeAvailable: false,
      estimatedGrade: null,
      gradeLabel: 'Mock only',
      confidence: 'low',
      disclaimer: 'AI-estimated raw condition grade, not an official PSA/BGS/CGC grade.',
      message: 'Mock/dev only: condition grading is not run in frontend mock mode.'
    },
    detectionNotes: [
      'Mock/dev only result. No OCR, backend, pricing provider, or card database was called.',
      `Mock state: ${normalizedState}.`,
      selectedGame ? `Selected game: ${selectedGame}.` : 'No game selected.'
    ],
    debug: {
      mock: true,
      resultDecision: {
        status: confirmed ? 'identified' : needsBetterPhoto ? 'needs_better_photo' : 'needs_confirmation',
        confirmedIdentity: confirmed,
        pricingEligible: confirmed,
        reason: 'Frontend-only mock scan for Vercel/mobile UI testing.'
      }
    }
  };
}

export function getApiDiagnostics() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return {
    frontendOrigin: origin,
    apiBaseUrl: API_BASE_URL || origin || 'same-origin',
    mode: import.meta.env.MODE,
    mockScan: USE_MOCK_SCAN
  };
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'The card detection request failed.');
  }
  return payload;
}

function withTimeout(promise, ms, controller) {
  const timeout = setTimeout(() => controller.abort(), ms);
  return promise.finally(() => clearTimeout(timeout));
}

export async function detectCardScan({ frontFile, backFile, selectedGame, selectedLanguage, manualCrop, debugMode }) {
  if (USE_MOCK_SCAN) {
    await delay();
    return buildMockScanResult({ frontFile, backFile, selectedGame, selectedLanguage, manualCrop, debugMode, state: getMockScanState() });
  }

  const formData = new FormData();
  formData.append('frontImage', frontFile);
  if (backFile) formData.append('backImage', backFile);
  if (selectedGame) formData.append('selectedGame', selectedGame);
  if (selectedLanguage) formData.append('selectedLanguage', selectedLanguage);
  if (debugMode) formData.append('debugMode', 'true');
  if (manualCrop) formData.append('manualCrop', JSON.stringify(manualCrop));
  const controller = new AbortController();
  try {
    const response = await withTimeout(
      fetch(`${API_BASE_URL}/api/cards/detect`, { method: 'POST', body: formData, signal: controller.signal }),
      28000,
      controller
    );
    return readJson(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Could not detect card. Please try a clearer image or select the card game manually.');
    }
    throw error;
  }
}

export async function confirmDetectedCard({ scanId, confirmedCardId, confirmedSource, confirmedCandidate }) {
  if (USE_MOCK_SCAN) {
    await delay(250);
    const candidate = confirmedCandidate || MOCK_CANDIDATES.find((entry) => entry.id === confirmedCardId) || MOCK_CANDIDATES[0];
    return {
      ...buildMockScanResult({ selectedGame: candidate.game, selectedLanguage: candidate.language, state: 'userConfirmed' }),
      scanId,
      officialMatch: {
        ...candidate,
        confidenceLabel: 'User confirmed',
        confidenceScore: 1,
        source: confirmedSource || candidate.source || 'user_confirmed_mock'
      },
      closestMatch: candidate,
      reason: 'Mock/dev only: card identity was manually confirmed by the user.'
    };
  }

  return readJson(
    await fetch(`${API_BASE_URL}/api/cards/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId, confirmedCardId, confirmedSource, confirmedCandidate })
    })
  );
}

export async function correctDetectedCard({ scanId, cardName, cardNumber, setCode, language }) {
  if (USE_MOCK_SCAN) {
    await delay(250);
    const result = buildMockScanResult({ selectedLanguage: language, state: 'needs_confirmation' });
    return {
      ...result,
      scanId,
      detectedDetails: {
        ...result.detectedDetails,
        cardName: cardName || result.detectedDetails.cardName,
        cardNumber: cardNumber || result.detectedDetails.cardNumber,
        setCode: setCode || result.detectedDetails.setCode,
        language: language || result.detectedDetails.language
      },
      reason: 'Mock/dev only: correction search returned sample possible matches.'
    };
  }

  return readJson(
    await fetch(`${API_BASE_URL}/api/cards/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId, cardName, cardNumber, setCode, language })
    })
  );
}

export async function gradeCardCondition({ frontFile, backFile, debugMode }) {
  if (USE_MOCK_SCAN) {
    await delay(250);
    return {
      gradeAvailable: false,
      mode: 'unavailable',
      estimatedGrade: null,
      gradeLabel: 'Mock mode',
      confidence: 'low',
      disclaimer: 'AI-estimated raw condition grade, not an official PSA/BGS/CGC grade.',
      message: 'Mock/dev only: backend condition grading was not called.',
      warnings: ['Frontend mock mode is enabled.'],
      debug: { mock: true, hasFrontImage: Boolean(frontFile), hasBackImage: Boolean(backFile), debugMode: Boolean(debugMode) }
    };
  }

  const formData = new FormData();
  formData.append('frontImage', frontFile);
  if (backFile) formData.append('backImage', backFile);
  if (debugMode) formData.append('debugMode', 'true');
  return readJson(
    await fetch(`${API_BASE_URL}/api/cards/grade-condition`, {
      method: 'POST',
      body: formData
    })
  );
}

export async function fetchRecentScans() {
  if (USE_MOCK_SCAN) return [];
  return readJson(await fetch(`${API_BASE_URL}/api/cards/scans`));
}

export async function checkApiHealth() {
  if (USE_MOCK_SCAN) return { ok: true, mock: true };
  return readJson(await fetch(`${API_BASE_URL}/api/health`));
}
