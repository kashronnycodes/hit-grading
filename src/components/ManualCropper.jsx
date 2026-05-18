import { useEffect, useMemo, useRef, useState } from 'react';
import { Crop, Move } from 'lucide-react';

const CARD_ASPECT = 734 / 1024;

export function ManualCropper({ imageUrl, onSubmit, onCancel, submitting }) {
  const imageRef = useRef(null);
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [crop, setCrop] = useState({ x: 0.17, y: 0.08, width: 0.66, height: 0.66 });

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return undefined;
    const onLoad = () => {
      const width = image.naturalWidth || 1;
      const height = image.naturalHeight || 1;
      setImageSize({ width, height });
      const cropWidth = 0.64;
      const cropHeight = Math.min(0.82, cropWidth * width / (CARD_ASPECT * height));
      setCrop({
        x: (1 - cropWidth) / 2,
        y: Math.max(0.04, (1 - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight
      });
    };
    image.addEventListener('load', onLoad);
    if (image.complete) onLoad();
    return () => image.removeEventListener('load', onLoad);
  }, [imageUrl]);

  const cropStyle = useMemo(() => ({
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`
  }), [crop]);

  const beginInteraction = (event, mode) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      rect,
      crop
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    const state = dragRef.current;
    if (!state) return;

    const deltaX = (event.clientX - state.startX) / state.rect.width;
    const deltaY = (event.clientY - state.startY) / state.rect.height;

    if (state.mode === 'move') {
      setCrop((current) => ({
        ...current,
        x: clamp(state.crop.x + deltaX, 0, 1 - current.width),
        y: clamp(state.crop.y + deltaY, 0, 1 - current.height)
      }));
      return;
    }

    const width = clamp(state.crop.width + deltaX, 0.2, 0.92);
    const height = clamp(width * imageSize.width / (CARD_ASPECT * imageSize.height), 0.28, 0.9);
    setCrop({
      x: clamp(state.crop.x, 0, 1 - width),
      y: clamp(state.crop.y, 0, 1 - height),
      width,
      height
    });
  };

  const endInteraction = (event) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <section className="manual-cropper">
      <div className="results-topline">
        <Crop size={20} />
        <span>Manual Card Crop</span>
      </div>

      <p className="cropper-copy">
        Move the frame so it fits tightly around the card, then continue detection.
      </p>

      <div
        className="cropper-frame"
        ref={frameRef}
        onPointerMove={onPointerMove}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
      >
        <img ref={imageRef} src={imageUrl} alt="Manual crop source" />
        <div className="crop-box" style={cropStyle} onPointerDown={(event) => beginInteraction(event, 'move')}>
          <div className="crop-label"><Move size={14} /> Drag to position</div>
          <button type="button" className="crop-handle" onPointerDown={(event) => beginInteraction(event, 'resize')} aria-label="Resize crop" />
        </div>
      </div>

      <div className="result-actions">
        <button className="secondary-action confirm-action" disabled={submitting} onClick={() => onSubmit(crop)}>
          {submitting ? 'Detecting...' : 'Use This Crop'}
        </button>
        <button className="secondary-action ghost-action" disabled={submitting} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
