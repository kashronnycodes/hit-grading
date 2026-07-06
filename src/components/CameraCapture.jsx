import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

export function CameraCapture({ label, onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
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
          setReady(true);
        }
      } catch {
        setError('Camera permission was blocked or unavailable. Use gallery upload instead.');
      }
    }

    startCamera();

    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

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
    onCapture(file);
    onClose();
  };

  return (
    <div className="camera-modal" role="dialog" aria-modal="true" aria-label={`${label} camera capture`}>
      <div className="camera-panel">
        <div className="camera-header">
          <div>
            <strong>{label}</strong>
            <span>Place the card inside the box</span>
          </div>
          <button className="camera-icon-button" type="button" onClick={onClose} aria-label="Close camera">
            <X size={20} />
          </button>
        </div>

        <div className="camera-preview">
          <video ref={videoRef} playsInline muted autoPlay />
          <div className="camera-dim" aria-hidden="true" />
          <div className="camera-card-guide" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          {!ready && !error ? <p className="camera-status">Starting camera...</p> : null}
          {error ? <p className="camera-status camera-error">{error}</p> : null}
        </div>

        <ul className="camera-tips">
          <li>Keep the card flat</li>
          <li>Avoid glare</li>
          <li>Move closer if the card number is tiny</li>
          <li>Keep the whole card inside the frame</li>
        </ul>

        <button className="camera-capture-button" type="button" disabled={!ready || Boolean(error)} onClick={captureFrame}>
          <Camera size={20} /> Take Photo
        </button>
      </div>
    </div>
  );
}
