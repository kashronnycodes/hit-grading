import { useEffect, useMemo, useState, useTransition } from 'react';
import { CheckCircle2, LoaderCircle, Sparkles } from 'lucide-react';
import { AnalysisHistory } from './components/AnalysisHistory.jsx';
import { FileUpload } from './components/FileUpload.jsx';
import { HitLogo } from './components/HitLogo.jsx';
import { ManualCropper } from './components/ManualCropper.jsx';
import { Results } from './components/Results.jsx';
import {
  checkApiHealth,
  confirmDetectedCard,
  correctDetectedCard,
  detectCardScan,
  fetchRecentScans,
  getApiDiagnostics
} from './services/cardDetectionApi.js';

const supportedTypes = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];

function createPreview(file) {
  if (!isSupportedImage(file)) return '';
  if (file.type === 'image/heic' || file.type === 'image/heif') return '';
  return URL.createObjectURL(file);
}

function isSupportedImage(file) {
  return Boolean(file && (supportedTypes.includes(file.type) || /\.(jpe?g|png|heic|heif)$/i.test(file.name)));
}

function isDebugModeEnabled() {
  return import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');
}

async function compressForUpload(file) {
  if (!file || file.type === 'image/heic' || file.type === 'image/heif') return file;
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });

    const maxWidth = 1600;
    const scale = Math.min(1, maxWidth / image.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    return blob ? new File([blob], file.name.replace(/\.(png|jpe?g)$/i, '.jpg'), { type: 'image/jpeg' }) : file;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

export default function App() {
  const [files, setFiles] = useState({ front: null, back: null });
  const [previews, setPreviews] = useState({ front: '', back: '' });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedGame, setSelectedGame] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('');
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showManualCrop, setShowManualCrop] = useState(false);
  const [networkDiagnostic, setNetworkDiagnostic] = useState(null);
  const [isPending, startTransition] = useTransition();

  const canAnalyze = useMemo(() => Boolean(files.front), [files.front]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    let active = true;
    const details = getApiDiagnostics();
    checkApiHealth()
      .then(() => {
        const diagnostic = { ...details, apiHealth: 'ok' };
        console.info('[hit-grading:network]', diagnostic);
        if (active) setNetworkDiagnostic(diagnostic);
      })
      .catch((healthError) => {
        const diagnostic = {
          ...details,
          apiHealth: 'failed',
          error: healthError instanceof Error ? healthError.message : 'Unknown API health error.'
        };
        console.warn('[hit-grading:network]', diagnostic);
        if (active) setNetworkDiagnostic(diagnostic);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchRecentScans()
      .then((items) => {
        if (!active) return;
        startTransition(() => {
          setHistory(items);
        });
      })
      .catch(() => {
        // History gracefully falls back to empty when the API is offline.
      });
    return () => {
      active = false;
    };
  }, []);

  const updateFile = (side, file) => {
    setError('');
    setResult(null);
    setShowAlternatives(false);
    setShowManualCrop(false);
    if (file && !isSupportedImage(file)) {
      setError('Please upload JPG, PNG, or HEIC images only.');
      return;
    }
    setFiles((current) => ({ ...current, [side]: file }));
    setPreviews((current) => {
      if (current[side]) URL.revokeObjectURL(current[side]);
      return { ...current, [side]: createPreview(file) };
    });
  };

  const handleAnalyze = async () => {
    setError('');
    setResult(null);
    setShowAlternatives(false);

    if (!files.front) {
      setError('Please upload at least the front card image before detection.');
      return;
    }

    if (!selectedGame) {
      setError('Please select the card game first so detection stays fast and focused.');
      return;
    }

    setStatus('scanning');
    try {
      const compressedFront = await compressForUpload(files.front);
      const compressedBack = files.back ? await compressForUpload(files.back) : null;
      const detection = await detectCardScan({
        frontFile: compressedFront,
        backFile: compressedBack,
        selectedGame,
        selectedLanguage,
        debugMode: isDebugModeEnabled()
      });
      setResult(detection);
      setHistory((current) => [detection, ...current.filter((item) => item.scanId !== detection.scanId)].slice(0, 8));
      setShowManualCrop(detection.status === 'needs_manual_crop');
      setStatus(detection.status === 'partial' || detection.status === 'needs_manual_crop' || detection.status === 'needs_manual_review' ? 'review' : 'complete');
    } catch (analysisError) {
      setStatus('error');
      setError(analysisError.message || 'Card detection could not be completed. Please try again.');
    }
  };

  const reset = () => {
    setFiles({ front: null, back: null });
    setPreviews({ front: '', back: '' });
    setStatus('idle');
    setError('');
    setResult(null);
    setShowAlternatives(false);
    setShowManualCrop(false);
  };

  const handleConfirm = async (candidate) => {
    if (!result) return;
    try {
      const updated = await confirmDetectedCard({
        scanId: result.scanId,
        confirmedCardId: candidate.id,
        confirmedSource: candidate.source,
        confirmedCandidate: candidate
      });
      setResult(updated);
      setHistory((current) => [updated, ...current.filter((item) => item.scanId !== updated.scanId)].slice(0, 8));
      setShowAlternatives(false);
      setStatus('complete');
    } catch (confirmError) {
      setError(confirmError.message || 'Could not confirm the detected card.');
    }
  };

  const handleAlternativePick = (candidate) => {
    if (!result) return;
    setResult({
      ...result,
      closestMatch: candidate,
      alternatives: [result.closestMatch, ...(result.alternatives || []).filter((entry) => entry.id !== candidate.id)].filter(Boolean),
      needsUserConfirmation: true
    });
  };

  const handleCorrectionSearch = async (fields) => {
    if (!result) return;
    setError('');
    setStatus('scanning');
    try {
      const updated = await correctDetectedCard({
        scanId: result.scanId,
        ...fields
      });
      setResult(updated);
      setHistory((current) => [updated, ...current.filter((item) => item.scanId !== updated.scanId)].slice(0, 8));
      setShowAlternatives(false);
      setStatus(updated.status === 'success' || updated.status === 'success_with_fallback' ? 'complete' : 'review');
    } catch (correctionError) {
      setStatus('review');
      setError(correctionError.message || 'Could not re-run the card search.');
    }
  };

  const handleManualCropDetect = async (manualCrop) => {
    if (!files.front) return;
    setError('');
    setStatus('scanning');
    try {
      const compressedFront = await compressForUpload(files.front);
      const compressedBack = files.back ? await compressForUpload(files.back) : null;
      const detection = await detectCardScan({
        frontFile: compressedFront,
        backFile: compressedBack,
        selectedGame,
        selectedLanguage,
        manualCrop,
        debugMode: isDebugModeEnabled()
      });
      setResult(detection);
      setHistory((current) => [detection, ...current.filter((item) => item.scanId !== detection.scanId)].slice(0, 8));
      setShowManualCrop(detection.status === 'needs_manual_crop');
      setStatus(detection.status === 'partial' || detection.status === 'needs_manual_crop' || detection.status === 'needs_manual_review' ? 'review' : 'complete');
    } catch (analysisError) {
      setStatus('error');
      setError(analysisError.message || 'Manual crop detection could not be completed. Please try again.');
    }
  };

  return (
    <main className="page-shell">
      <header className="brand-header">
        <HitLogo />
        <h1>Professional Card Condition Analysis &amp; Market Valuation</h1>
        <p><Sparkles size={17} /> Powered by Advanced AI Technology</p>
        <div className="domain-line"><span aria-hidden="true" /> Part of hitgrading.com</div>
      </header>

      {import.meta.env.DEV && networkDiagnostic ? (
        <div className={`network-diagnostic ${networkDiagnostic.apiHealth === 'ok' ? 'ok' : 'failed'}`}>
          <strong>Dev network:</strong>
          <span>{networkDiagnostic.frontendOrigin}</span>
          <span>API {networkDiagnostic.apiBaseUrl}</span>
          <span>{networkDiagnostic.apiHealth === 'ok' ? 'API connected' : `API failed: ${networkDiagnostic.error}`}</span>
        </div>
      ) : null}

      {!result ? (
        <section className="upload-card" aria-busy={status === 'scanning'}>
          <FileUpload
            id="front-upload"
            label="Card Front Image"
            file={files.front}
            preview={previews.front}
            onChange={(file) => updateFile('front', file)}
          />
          <FileUpload
            id="back-upload"
            label="Card Back Image"
            file={files.back}
            preview={previews.back}
            onChange={(file) => updateFile('back', file)}
          />

          <div className="detect-options">
            <label className="option-field">
              <span>Game</span>
              <select value={selectedGame} onChange={(event) => setSelectedGame(event.target.value)}>
                <option value="">Select game</option>
                <option value="pokemon">Pokemon</option>
                <option value="magic">Magic: The Gathering</option>
                <option value="yugioh">Yu-Gi-Oh!</option>
                <option value="lorcana">Lorcana</option>
                <option value="onepiece">One Piece</option>
              </select>
            </label>
            <label className="option-field">
              <span>Language</span>
              <select value={selectedLanguage} onChange={(event) => setSelectedLanguage(event.target.value)}>
                <option value="">Auto-detect</option>
                <option value="en">English</option>
                <option value="ja">Japanese</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="es">Spanish</option>
              </select>
            </label>
          </div>

          {error ? <p className="error-message">{error}</p> : null}

          <button className={`analyze-button ${canAnalyze ? 'ready' : ''}`} onClick={handleAnalyze} disabled={status === 'scanning'}>
            {status === 'scanning' ? <LoaderCircle className="spin" size={24} /> : <CheckCircle2 size={24} />}
            {status === 'scanning' ? 'Detecting Card...' : 'Detect Card'}
          </button>

          {status === 'scanning' ? (
            <div className="scanner">
              <div className="scanner-line" />
              <span>Detecting the card, extracting OCR, ranking matches, and collecting pricing metadata</span>
            </div>
          ) : (
            <p className={`ready-state ${canAnalyze ? 'ready' : ''}`}>
              {status === 'error'
                ? 'Detection stopped. Adjust the image or select the game and try again.'
                : canAnalyze
                  ? 'Front image is ready for card detection. Back image is optional for future grading.'
                  : 'Upload the front card image to begin.'}
            </p>
          )}
        </section>
      ) : showManualCrop ? (
        <ManualCropper
          imageUrl={result.rawImageUrl}
          initialCrop={result.crop?.coordinates}
          submitting={status === 'scanning'}
          onSubmit={handleManualCropDetect}
          onCancel={() => setShowManualCrop(false)}
        />
      ) : (
        <Results
          result={result}
          files={files}
          previews={previews}
          onReset={reset}
          onConfirm={handleConfirm}
          onShowAlternatives={() => setShowAlternatives((current) => !current)}
          onPickAlternative={handleAlternativePick}
          showAlternatives={showAlternatives}
          onStartManualCrop={() => setShowManualCrop(true)}
          onCorrectResult={handleCorrectionSearch}
          correcting={status === 'scanning'}
        />
      )}

      <AnalysisHistory items={history} loading={isPending} />
    </main>
  );
}
