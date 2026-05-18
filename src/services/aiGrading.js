const conditionLabels = [
  { min: 9.5, label: 'Gem Mint' },
  { min: 8.5, label: 'Mint' },
  { min: 7.5, label: 'Near Mint' },
  { min: 6.5, label: 'Excellent' },
  { min: 5.5, label: 'Very Good' },
  { min: 4.5, label: 'Good' },
  { min: 0, label: 'Authentic / Heavy Wear' }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadBitmap(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This browser could not preview one of the uploaded images. For HEIC files, convert to JPG/PNG or connect the production AI endpoint.'));
    };

    image.src = url;
  });
}

function sampleImage(image) {
  const canvas = document.createElement('canvas');
  const size = 280;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#05070d';
  context.fillRect(0, 0, size, size);

  const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (size - width) / 2;
  const y = (size - height) / 2;
  context.drawImage(image, x, y, width, height);

  const { data } = context.getImageData(0, 0, size, size);
  let luminanceTotal = 0;
  let contrastTotal = 0;
  let edgeTotal = 0;
  let scratchTotal = 0;
  let whiteSpeckTotal = 0;
  const luminance = new Float32Array(size * size);

  for (let i = 0; i < data.length; i += 4) {
    const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    luminance[i / 4] = lum;
    luminanceTotal += lum;
  }

  const mean = luminanceTotal / luminance.length;

  for (let index = 0; index < luminance.length; index += 1) {
    contrastTotal += Math.abs(luminance[index] - mean);
    if (luminance[index] > 0.88) whiteSpeckTotal += 1;
  }

  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const index = y * size + x;
      const dx = Math.abs(luminance[index] - luminance[index + 1]);
      const dy = Math.abs(luminance[index] - luminance[index + size]);
      const gradient = dx + dy;
      edgeTotal += gradient;
      if (gradient > 0.52 && luminance[index] > 0.35) scratchTotal += 1;
    }
  }

  const left = columnAverage(luminance, size, 8, 38);
  const right = columnAverage(luminance, size, size - 38, size - 8);
  const top = rowAverage(luminance, size, 8, 38);
  const bottom = rowAverage(luminance, size, size - 38, size - 8);

  return {
    exposure: 1 - Math.abs(mean - 0.52) * 1.55,
    contrast: contrastTotal / luminance.length,
    sharpness: edgeTotal / ((size - 2) * (size - 2)),
    scratchSignal: scratchTotal / luminance.length,
    whiteningSignal: whiteSpeckTotal / luminance.length,
    centeringBalance: 1 - (Math.abs(left - right) + Math.abs(top - bottom)) / 2
  };
}

function columnAverage(luminance, size, start, end) {
  let total = 0;
  let count = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = start; x < end; x += 1) {
      total += luminance[y * size + x];
      count += 1;
    }
  }
  return total / count;
}

function rowAverage(luminance, size, start, end) {
  let total = 0;
  let count = 0;
  for (let y = start; y < end; y += 1) {
    for (let x = 0; x < size; x += 1) {
      total += luminance[y * size + x];
      count += 1;
    }
  }
  return total / count;
}

function buildResult(frontSignals, backSignals) {
  const average = (key) => (frontSignals[key] + backSignals[key]) / 2;
  const centering = clamp(7.2 + average('centeringBalance') * 2.35 - Math.abs(frontSignals.centeringBalance - backSignals.centeringBalance) * 2.2, 1, 10);
  const surface = clamp(9.35 - average('scratchSignal') * 28 - average('whiteningSignal') * 6 + average('exposure') * 0.55, 1, 10);
  const edges = clamp(9.15 - average('whiteningSignal') * 16 + average('sharpness') * 1.8, 1, 10);
  const corners = clamp(edges - average('scratchSignal') * 5 + average('contrast') * 0.8, 1, 10);
  const grade = clamp((centering * 0.24 + corners * 0.25 + edges * 0.23 + surface * 0.28), 1, 10);
  const confidence = Math.round(clamp(72 + average('sharpness') * 75 + average('contrast') * 28 - Math.abs(frontSignals.exposure - backSignals.exposure) * 14, 55, 96));
  const conditionLabel = conditionLabels.find((item) => grade >= item.min).label;

  const notes = [
    centering < 8.4 ? 'Border balance suggests visible centering variation between sides.' : 'Centering appears strong from the supplied photos.',
    surface < 8.5 ? 'Surface scan detected possible fine marks, glare, or texture interruptions.' : 'Surface appears clean with limited visible marking.',
    edges < 8.5 ? 'Edge/whitening signal is elevated, especially along high-contrast borders.' : 'Edges show low whitening signal in the uploaded images.',
    confidence < 78 ? 'Confidence is reduced by lighting, angle, or image clarity. A flatter scan would improve precision.' : 'Image clarity is sufficient for a strong automated estimate.'
  ];

  const lowValue = Math.max(5, Math.round(grade * grade * 2.2));
  const highValue = Math.round(lowValue * (1.75 + Math.max(0, grade - 7) * 0.28));

  return {
    grade: Number(grade.toFixed(1)),
    conditionLabel,
    confidence,
    breakdown: {
      centering,
      corners,
      edges,
      surface
    },
    notes,
    marketValueRange: `$${lowValue} - $${highValue}`
  };
}

export async function analyzeCardImages(frontFile, backFile) {
  await wait(1050);

  const endpoint = import.meta.env.VITE_AI_GRADING_ENDPOINT;
  if (endpoint) {
    const payload = new FormData();
    payload.append('front', frontFile);
    payload.append('back', backFile);
    const response = await fetch(endpoint, { method: 'POST', body: payload });
    if (!response.ok) throw new Error('The AI grading service rejected the upload. Please try again.');
    return response.json();
  }

  const [frontImage, backImage] = await Promise.all([loadBitmap(frontFile), loadBitmap(backFile)]);
  return buildResult(sampleImage(frontImage), sampleImage(backImage));
}
