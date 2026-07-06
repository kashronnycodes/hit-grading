const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

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
  return readJson(
    await fetch(`${API_BASE_URL}/api/cards/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId, confirmedCardId, confirmedSource, confirmedCandidate })
    })
  );
}

export async function correctDetectedCard({ scanId, cardName, cardNumber, setCode, language }) {
  return readJson(
    await fetch(`${API_BASE_URL}/api/cards/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId, cardName, cardNumber, setCode, language })
    })
  );
}

export async function gradeCardCondition({ frontFile, backFile, debugMode }) {
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
  return readJson(await fetch(`${API_BASE_URL}/api/cards/scans`));
}
