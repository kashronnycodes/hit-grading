import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Check, RefreshCcw, X } from 'lucide-react';

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function getCameraErrorMessage(cameraError) {
  const isInsecureContext = typeof window !== 'undefined' && !window.isSecureContext;
  const browserMessage = cameraError instanceof Error ? cameraError.message : '';
  if (isInsecureContext) {
    return 'Camera capture may require HTTPS on this phone browser. Use gallery upload, localhost, or an HTTPS tunnel for camera testing.';
  }
  return `Camera permission was blocked or unavailable. Use gallery upload instead.${browserMessage ? ` (${browserMessage})` : ''}`;
}

export function CameraCapture({ label, onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const capturedUrlRef = useRef('');
  const autoCapturedRef = useRef(false);
  const closeButtonRef = useRef(null);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const closingRef = useRef(false);
  const closeTimerRef = useRef(null);
  const readinessTimerRef = useRef(null);
  const scrollLockRef = useRef(null);
  const [error, setError] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [readiness, setReadiness] = useState('starting');
  const [autoCapture, setAutoCapture] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [capturedFile, setCapturedFile] = useState(null);
  const [capturedPreview, setCapturedPreview] = useState('');
  const [isClosing, setIsClosing] = useState(false);
  const [shutterFlash, setShutterFlash] = useState(false);

  const stopCameraStream = useCallback(() => {
    if (!streamRef.current) return;
    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
  }, []);

  const restoreScrollLock = useCallback(() => {
    const lock = scrollLockRef.current;
    if (!lock || typeof window === 'undefined') return;
    const { bodyStyles, htmlStyles, scrollY } = lock;
    Object.assign(document.body.style, bodyStyles);
    Object.assign(document.documentElement.style, htmlStyles);
    window.scrollTo(0, scrollY);
    scrollLockRef.current = null;
  }, []);

  const closeCamera = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    stopCameraStream();
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 150);
  }, [onClose, stopCameraStream]);

  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight || capturedFile) return;

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
    stopCameraStream();
    setShutterFlash(true);
    window.setTimeout(() => setShutterFlash(false), 140);
    setCapturedFile(file);
    setCapturedPreview(URL.createObjectURL(file));
  }, [capturedFile, label, stopCameraStream]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    previousFocusRef.current = document.activeElement;
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    scrollLockRef.current = {
      scrollY,
      bodyStyles: {
        position: document.body.style.position,
        top: document.body.style.top,
        left: document.body.style.left,
        right: document.body.style.right,
        width: document.body.style.width,
        overflow: document.body.style.overflow,
        overscrollBehavior: document.body.style.overscrollBehavior,
        touchAction: document.body.style.touchAction
      },
      htmlStyles: {
        overflow: document.documentElement.style.overflow,
        overscrollBehavior: document.documentElement.style.overscrollBehavior,
        touchAction: document.documentElement.style.touchAction
      }
    };

    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.body.style.touchAction = 'none';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    document.documentElement.style.touchAction = 'none';

    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      stopCameraStream();
      restoreScrollLock();
      previousFocusRef.current?.focus?.();
    };
  }, [restoreScrollLock, stopCameraStream]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCamera();
        return;
      }

      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll(focusableSelector));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeCamera]);

  useEffect(() => {
    if (capturedPreview) capturedUrlRef.current = capturedPreview;
  }, [capturedPreview]);

  useEffect(() => {
    return () => {
      if (capturedUrlRef.current) URL.revokeObjectURL(capturedUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (capturedFile || closingRef.current) return undefined;
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
        if (!active || closingRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraActive(true);
          setReadiness('stabilizing');
          readinessTimerRef.current = window.setTimeout(() => {
            if (active && !closingRef.current) setReadiness('ready');
          }, 1800);
        }
      } catch (cameraError) {
        stopCameraStream();
        setError(getCameraErrorMessage(cameraError));
      }
    }

    startCamera();

    return () => {
      active = false;
      if (readinessTimerRef.current) window.clearTimeout(readinessTimerRef.current);
      stopCameraStream();
    };
  }, [capturedFile, stopCameraStream]);

  useEffect(() => {
    if (!autoCapture || capturedFile || error || readiness !== 'ready' || autoCapturedRef.current || isClosing) {
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
  }, [autoCapture, captureFrame, capturedFile, error, isClosing, readiness]);

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
    stopCameraStream();
    onCapture(capturedFile);
    closeCamera();
  };

  const handleBackdropMouseDown = (event) => {
    if (event.target === event.currentTarget) closeCamera();
  };

  const readinessCopy = {
    starting: 'Align card inside the frame',
    stabilizing: 'Hold steady',
    ready: 'Ready to capture'
  };

  const readinessClass = readiness === 'ready' ? 'ready' : readiness === 'stabilizing' ? 'stabilizing' : 'starting';

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`camera-overlay ${isClosing ? 'is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${label} camera capture`}
      onMouseDown={handleBackdropMouseDown}
    >
      <div className="camera-dialog" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <div className="camera-toolbar">
          <div>
            <strong>Align your card.</strong>
            <span>{label} capture</span>
          </div>
          <button ref={closeButtonRef} className="camera-close-button" type="button" onClick={closeCamera} aria-label="Close camera">
            <X size={22} />
          </button>
        </div>

        <div className={`camera-viewport ${capturedFile ? 'preview-mode' : ''}`}>
          {capturedPreview ? <img className="camera-photo-preview" src={capturedPreview} alt="Captured card preview" /> : <video ref={videoRef} className="camera-video" playsInline muted autoPlay />}
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
            </>
          ) : null}
          {shutterFlash ? <div className="camera-shutter-flash" aria-hidden="true" /> : null}
          {!cameraActive && !error && !capturedFile ? <p className="camera-status">Starting camera...</p> : null}
          {error ? <p className="camera-status camera-error">{error}</p> : null}
        </div>

        <div className="camera-bottom-bar">
          <div className={`camera-readiness ${capturedFile ? 'ready' : readinessClass}`}>
            <strong>{capturedFile ? 'Review photo' : readinessCopy[readiness]}</strong>
            {capturedFile
              ? <span>Use it or retake before scanning</span>
              : autoCapture && countdown
                ? <span>Auto capturing in {countdown}...</span>
                : <span>Place the card inside the frame. Keep the bottom number clear.</span>}
          </div>

          <ul className="camera-tips">
            <li>Place card inside frame</li>
            <li>Avoid glare</li>
            <li>Keep bottom number clear</li>
            <li>Hold steady</li>
          </ul>

          {!capturedFile ? (
            <div className="camera-actions">
              <label className={`camera-auto-toggle ${autoCapture ? 'is-selected' : ''}`}>
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
    </div>,
    document.body
  );
}
