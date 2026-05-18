import { useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, Sparkles } from 'lucide-react';
import { AnalysisHistory } from './components/AnalysisHistory.jsx';
import { FileUpload } from './components/FileUpload.jsx';
import { HitLogo } from './components/HitLogo.jsx';
import { Results } from './components/Results.jsx';
import { analyzeCardImages } from './services/aiGrading.js';

const supportedTypes = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];

function createPreview(file) {
  if (!isSupportedImage(file)) return '';
  if (file.type === 'image/heic' || file.type === 'image/heif') return '';
  return URL.createObjectURL(file);
}

function isSupportedImage(file) {
  return Boolean(file && (supportedTypes.includes(file.type) || /\.(jpe?g|png|heic|heif)$/i.test(file.name)));
}

export default function App() {
  const [files, setFiles] = useState({ front: null, back: null });
  const [previews, setPreviews] = useState({ front: '', back: '' });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  const canAnalyze = useMemo(() => Boolean(files.front && files.back), [files]);

  const updateFile = (side, file) => {
    setError('');
    setResult(null);
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

    if (!files.front || !files.back) {
      setError('Please upload both the front and back card images before analysis.');
      return;
    }

    setStatus('scanning');
    try {
      const analysis = await analyzeCardImages(files.front, files.back);
      setResult(analysis);
      setHistory((current) => [
        {
          id: `${Date.now()}-${files.front.name}`,
          frontName: files.front.name,
          backName: files.back.name,
          createdAt: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date()),
          previews: { ...previews },
          grade: analysis.grade,
          conditionLabel: analysis.conditionLabel,
          confidence: analysis.confidence,
          marketValueRange: analysis.marketValueRange
        },
        ...current
      ].slice(0, 8));
      setStatus('complete');
    } catch (analysisError) {
      setStatus('idle');
      setError(analysisError.message || 'AI analysis could not be completed. Please try again.');
    }
  };

  const reset = () => {
    setFiles({ front: null, back: null });
    setPreviews({ front: '', back: '' });
    setStatus('idle');
    setError('');
    setResult(null);
  };

  return (
    <main className="page-shell">
      <header className="brand-header">
        <HitLogo />
        <h1>Professional Card Condition Analysis &amp; Market Valuation</h1>
        <p><Sparkles size={17} /> Powered by Advanced AI Technology</p>
        <div className="domain-line"><span aria-hidden="true" /> Part of hitgrading.com</div>
      </header>

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

          {error ? <p className="error-message">{error}</p> : null}

          <button className={`analyze-button ${canAnalyze ? 'ready' : ''}`} onClick={handleAnalyze} disabled={status === 'scanning'}>
            {status === 'scanning' ? <LoaderCircle className="spin" size={24} /> : <CheckCircle2 size={24} />}
            {status === 'scanning' ? 'Scanning Card...' : 'Analyze Card'}
          </button>

          {status === 'scanning' ? (
            <div className="scanner">
              <div className="scanner-line" />
              <span>Inspecting centering, corners, edges, surface, whitening, dents, and print defects</span>
            </div>
          ) : (
            <p className={`ready-state ${canAnalyze ? 'ready' : ''}`}>
              {canAnalyze ? 'Both images are ready for AI grading.' : 'Upload front and back images to begin.'}
            </p>
          )}
        </section>
      ) : (
        <Results result={result} files={files} previews={previews} onReset={reset} />
      )}

      <AnalysisHistory items={history} />
    </main>
  );
}
