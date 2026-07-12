import { useEffect, useRef, useState } from 'react';
import { Camera, Check, RefreshCcw, X } from 'lucide-react';

export function CameraCapture({ label, onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const capturedUrlRef = useRef('');
  const autoCapturedRef = useRef(false);
  const [error, setError] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [readiness, setReadiness] = useState('starting');
  const [autoCapture, setAutoCapture] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [capturedFile, setCapturedFile] = useState(null);
  const [capturedPreview, setCapturedPreview] = useState('');

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (capturedPreview) capturedUrlRef.current = capturedPreview;
  }, [capturedPreview]);

  useEffect(() => {
    return () => {
      if (capturedUrlRef.current) URL.revokeObjectURL(capturedUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (capturedFile) return undefined;
    let active = true;

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera capture is not supported in this browser. Use gallery upload instead.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 1920 }
          },
          audio: false
        });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraActive(true);
          setReadiness('stabilizing');
          window.setTimeout(() => {
            if (active) setReadiness('ready');
          }, 1800);
        }
      } catch (cameraError) {
        const isInsecureContext = typeof window !== 'undefined' && !window.isSecureContext;
        const browserMessage = cameraError instanceof Error ? cameraError.message : '';
        setError(
          isInsecureContext
            ? 'Camera capture may require HTTPS on this phone browser. Use gallery upload, localhost, or an HTTPS tunnel for camera testing.'
            : `Camera permission was blocked or unavailable. Use gallery upload instead.${browserMessage ? ` (${browserMessage})` : ''}`
        );
      }
    }

    startCamera();

    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [capturedFile]);

  useEffect(() => {
    if (!autoCapture || capturedFile || error || readiness !== 'ready' || autoCapturedRef.current) {
      setCountdown(null);
      return undefined;
    }

    setCountdown(2);
    const firstTick = window.setTimeout(() => setCountdown(1), 1000);
    const captureTick = window.setTimeout(() => {
      autoCapturedRef.current = true;
      captureFrame();
    }, 2000);

    return () => {
      window.clearTimeout(firstTick);
      window.clearTimeout(captureTick);
    };
  }, [autoCapture, capturedFile, error, readiness]);

  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) return;

    const file = new File([blob], `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-camera.jpg`, {
      type: 'image/jpeg'
    });
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
    setCapturedFile(file);
    setCapturedPreview(URL.createObjectURL(file));
  };

  const retake = () => {
    if (capturedPreview) URL.revokeObjectURL(capturedPreview);
    capturedUrlRef.current = '';
    autoCapturedRef.current = false;
    setCapturedFile(null);
    setCapturedPreview('');
    setCountdown(null);
    setReadiness('starting');
    setError('');
  };

  const usePhoto = () => {
    if (!capturedFile) return;
    onCapture(capturedFile);
    onClose();
  };

  const closeCamera = () => {
    onClose();
  };

  const readinessCopy = {
    starting: 'Align card inside the frame',
    stabilizing: 'Hold steady',
    ready: 'Ready to capture'
  };

  const readinessClass = readiness === 'ready' ? 'ready' : readiness === 'stabilizing' ? 'stabilizing' : 'starting';

  return (
    <div className="camera-modal" role="dialog" aria-modal="true" aria-label={`${label} camera capture`}>
      <div className="camera-panel">
        <div className="camera-header">
          <div>
            <strong>Align your card.</strong>
            <span>{label} capture</span>
          </div>
          <button className="camera-icon-button" type="button" onClick={closeCamera} aria-label="Close camera">
            <X size={20} />
          </button>
        </div>

        <div className={`camera-preview ${capturedFile ? 'preview-mode' : ''}`}>
          {capturedPreview ? <img className="camera-photo-preview" src={capturedPreview} alt="Captured card preview" /> : <video ref={videoRef} playsInline muted autoPlay />}
          {!capturedFile ? (
            <>
              <div className="camera-dim" aria-hidden="true" />
              <div className={`camera-card-guide ${readinessClass}`} aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <i />
                <i />
              </div>
              <div className={`camera-readiness ${readinessClass}`}>
                <strong>{readinessCopy[readiness]}</strong>
                {autoCapture && countdown ? <span>Auto capturing in {countdown}...</span> : <span>Place the card inside the frame</span>}
              </div>
            </>
          ) : (
            <div className="camera-readiness ready">
              <strong>Review photo</strong>
              <span>Use it or retake before scanning</span>
            </div>
          )}
          {!cameraActive && !error && !capturedFile ? <p className="camera-status">Starting camera...</p> : null}
          {error ? <p className="camera-status camera-error">{error}</p> : null}
        </div>

        <ul className="camera-tips">
          <li>Place the card inside the frame</li>
          <li>Keep the card flat</li>
          <li>Avoid glare</li>
          <li>Keep the bottom card number clear</li>
          <li>Hold steady</li>
        </ul>

        {!capturedFile ? (
          <div className="camera-actions">
            <label className="camera-auto-toggle">
              <input type="checkbox" checked={autoCapture} onChange={(event) => setAutoCapture(event.target.checked)} />
              <span>Auto capture when ready</span>
            </label>
            <button className="camera-capture-button" type="button" disabled={!cameraActive || Boolean(error)} onClick={captureFrame}>
              <Camera size={20} /> Capture
            </button>
          </div>
        ) : (
          <div className="camera-actions preview-actions">
            <button className="camera-secondary-button" type="button" onClick={retake}>
              <RefreshCcw size={19} /> Retake
            </button>
            <button className="camera-capture-button" type="button" onClick={usePhoto}>
              <Check size={20} /> Use Photo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
