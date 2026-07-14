import sharp from 'sharp';

type Point = { x: number; y: number };

export type CardBoundaryDetection = {
  corners: [Point, Point, Point, Point];
  aspectRatio: number;
  confidence: number;
  method: 'edge-contour' | 'threshold-contour';
  outlinedDebugBuffer: Buffer;
  candidates: CardBoundaryCandidateDiagnostic[];
};

export type CardBoundaryCandidateDiagnostic = {
  method: CardBoundaryDetection['method'];
  width: number;
  height: number;
  areaRatio: number;
  aspectRatio: number;
  confidence?: number;
  valid: boolean;
  rejectionReason?: string;
};

export type CardBoundaryDetectionResult = {
  detection: CardBoundaryDetection | null;
  candidates: CardBoundaryCandidateDiagnostic[];
};

export class CardBoundaryDetectionService {
  async detect(buffer: Buffer): Promise<CardBoundaryDetectionResult> {
    const primary = await this.detectWithMethod(buffer, 'edge-contour');
    if (primary.detection) return primary;
    const secondary = await this.detectWithMethod(buffer, 'threshold-contour');
    return {
      detection: secondary.detection,
      candidates: [...primary.candidates, ...secondary.candidates]
    };
  }

  async warpCard(buffer: Buffer, corners: [Point, Point, Point, Point], width = 734, height = 1024): Promise<Buffer> {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const source = new Uint8ClampedArray(data);
    const matrix = solveHomography(
      [
        { x: 0, y: 0 },
        { x: width - 1, y: 0 },
        { x: width - 1, y: height - 1 },
        { x: 0, y: height - 1 }
      ],
      corners
    );

    const output = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourcePoint = projectPoint(matrix, x, y);
        const pixel = sampleBilinear(source, info.width, info.height, sourcePoint.x, sourcePoint.y, info.channels);
        const index = (y * width + x) * 4;
        output[index] = pixel[0];
        output[index + 1] = pixel[1];
        output[index + 2] = pixel[2];
        output[index + 3] = pixel[3];
      }
    }

    let corrected = sharp(output, { raw: { width, height, channels: 4 } });
    if (averageDistance(corners[0], corners[1], corners[2], corners[3]) > averageVerticalDistance(corners[0], corners[3], corners[1], corners[2])) {
      corrected = corrected.rotate(90);
    }
    return corrected.resize({ width: 734, height: 1024, fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
  }

  private async detectWithMethod(buffer: Buffer, method: CardBoundaryDetection['method']): Promise<CardBoundaryDetectionResult> {
    const { data, info } = await sharp(buffer)
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const grayscale = new Uint8Array(data);
    const sourceWidth = info.width;
    const sourceHeight = info.height;
    const mask = method === 'edge-contour'
      ? buildEdgeMask(grayscale, sourceWidth, sourceHeight)
      : buildThresholdMask(grayscale, sourceWidth, sourceHeight);

    const components = findComponents(mask, sourceWidth, sourceHeight);
    if (!components.length) return { detection: null, candidates: [] };

    const targetAspect = 734 / 1024;
    const scored = components.map((component) => scoreComponent(component, sourceWidth, sourceHeight, targetAspect, method));
    const best = scored
      .filter((candidate) => candidate.valid && candidate.confidence >= 0.28)
      .sort((a, b) => b.areaRatio - a.areaRatio || b.confidence - a.confidence)[0];

    const candidates = scored.map(({ corners: _corners, ...candidate }) => candidate);
    if (!best) return { detection: null, candidates };

    const metadata = await sharp(buffer).metadata();
    const scaleX = metadata.width ? metadata.width / sourceWidth : 1;
    const scaleY = metadata.height ? metadata.height / sourceHeight : 1;
    const corners = best.corners.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })) as [Point, Point, Point, Point];
    const outlinedDebugBuffer = await renderOutline(buffer, corners);

    const detection: CardBoundaryDetection = {
      corners,
      aspectRatio: best.aspectRatio,
      confidence: best.confidence,
      method,
      outlinedDebugBuffer,
      candidates
    };
    return { detection, candidates };
  }
}

type Component = {
  pixels: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function buildEdgeMask(grayscale: Uint8Array, width: number, height: number): Uint8Array {
  const magnitude = new Float32Array(width * height);
  let max = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx =
        -getGray(grayscale, width, x - 1, y - 1) + getGray(grayscale, width, x + 1, y - 1) +
        -2 * getGray(grayscale, width, x - 1, y) + 2 * getGray(grayscale, width, x + 1, y) +
        -getGray(grayscale, width, x - 1, y + 1) + getGray(grayscale, width, x + 1, y + 1);
      const gy =
        -getGray(grayscale, width, x - 1, y - 1) - 2 * getGray(grayscale, width, x, y - 1) - getGray(grayscale, width, x + 1, y - 1) +
        getGray(grayscale, width, x - 1, y + 1) + 2 * getGray(grayscale, width, x, y + 1) + getGray(grayscale, width, x + 1, y + 1);
      const value = Math.sqrt(gx * gx + gy * gy);
      magnitude[y * width + x] = value;
      if (value > max) max = value;
    }
  }

  const threshold = Math.max(24, max * 0.28);
  const binary = new Uint8Array(width * height);
  for (let index = 0; index < magnitude.length; index += 1) {
    binary[index] = magnitude[index] >= threshold ? 1 : 0;
  }
  return dilate(binary, width, height, 2);
}

function buildThresholdMask(grayscale: Uint8Array, width: number, height: number): Uint8Array {
  let sum = 0;
  for (const value of grayscale) sum += value;
  const mean = sum / grayscale.length;
  const binary = new Uint8Array(width * height);
  for (let index = 0; index < grayscale.length; index += 1) {
    const value = grayscale[index];
    binary[index] = Math.abs(value - mean) > 28 ? 1 : 0;
  }
  return dilate(binary, width, height, 3);
}

function dilate(mask: Uint8Array, width: number, height: number, iterations: number): Uint8Array {
  let current = mask;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let active = 0;
        for (let dy = -1; dy <= 1 && !active; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (current[(y + dy) * width + (x + dx)]) {
              active = 1;
              break;
            }
          }
        }
        next[y * width + x] = active;
      }
    }
    current = next;
  }
  return current;
}

function findComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];
  const queueX = new Int32Array(mask.length);
  const queueY = new Int32Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (!mask[startIndex] || visited[startIndex]) continue;

      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;
      visited[startIndex] = 1;

      const pixels: Point[] = [];
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (head < tail) {
        const currentX = queueX[head];
        const currentY = queueY[head];
        head += 1;
        pixels.push({ x: currentX, y: currentY });
        if (currentX < minX) minX = currentX;
        if (currentY < minY) minY = currentY;
        if (currentX > maxX) maxX = currentX;
        if (currentY > maxY) maxY = currentY;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = currentX + dx;
            const ny = currentY + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const index = ny * width + nx;
            if (!mask[index] || visited[index]) continue;
            visited[index] = 1;
            queueX[tail] = nx;
            queueY[tail] = ny;
            tail += 1;
          }
        }
      }

      components.push({ pixels, minX, minY, maxX, maxY });
    }
  }

  return components;
}

type ScoredComponent = CardBoundaryCandidateDiagnostic & {
  corners: [Point, Point, Point, Point];
  confidence: number;
};

function scoreComponent(
  component: Component,
  width: number,
  height: number,
  targetAspect: number,
  method: CardBoundaryDetection['method']
): ScoredComponent {
  const bboxWidth = component.maxX - component.minX + 1;
  const bboxHeight = component.maxY - component.minY + 1;
  const areaRatio = (bboxWidth * bboxHeight) / (width * height);
  const corners = estimateCorners(component.pixels);
  const quadWidth = averageDistance(corners[0], corners[1], corners[2], corners[3]);
  const quadHeight = averageVerticalDistance(corners[0], corners[3], corners[1], corners[2]);
  const longestQuadSide = Math.max(quadWidth, quadHeight);
  const aspectRatio = longestQuadSide > 0 ? Math.min(quadWidth, quadHeight) / longestQuadSide : 0;
  const widthRatio = bboxWidth / width;
  const heightRatio = bboxHeight / height;
  const minImageDimension = Math.min(width, height);
  const minPointDistance = minPairwiseDistance(corners);
  const rejectionReason = getComponentRejectionReason({
    bboxWidth,
    bboxHeight,
    widthRatio,
    heightRatio,
    areaRatio,
    aspectRatio,
    minPointDistance,
    minImageDimension,
    targetAspect
  });
  if (rejectionReason) {
    return {
      method,
      corners,
      width: bboxWidth,
      height: bboxHeight,
      areaRatio: round(areaRatio, 4),
      aspectRatio: round(aspectRatio, 3),
      confidence: 0,
      valid: false,
      rejectionReason
    };
  }

  const aspectScore = 1 - Math.min(Math.abs(aspectRatio - targetAspect), 0.5) / 0.5;
  const sizeScore = clamp((areaRatio - 0.08) / 0.45, 0, 1);
  const componentFill = clamp(component.pixels.length / (bboxWidth * bboxHeight), 0, 1);
  const fillScore = Math.min(componentFill * 1.6, 1);
  const confidence = Math.round((aspectScore * 0.45 + sizeScore * 0.35 + fillScore * 0.2) * 100) / 100;
  return {
    method,
    corners,
    width: bboxWidth,
    height: bboxHeight,
    areaRatio: round(areaRatio, 4),
    aspectRatio: round(aspectRatio, 3),
    confidence,
    valid: true
  };
}

function getComponentRejectionReason(input: {
  bboxWidth: number;
  bboxHeight: number;
  widthRatio: number;
  heightRatio: number;
  areaRatio: number;
  aspectRatio: number;
  minPointDistance: number;
  minImageDimension: number;
  targetAspect: number;
}) {
  const portraitSized = input.widthRatio >= 0.2 && input.heightRatio >= 0.35;
  const landscapeSized = input.widthRatio >= 0.35 && input.heightRatio >= 0.2;
  if (input.bboxWidth < 80 || input.bboxHeight < 80) return 'candidate bounding box is too small';
  if (!portraitSized && !landscapeSized) return 'candidate width/height ratios are too small for a card';
  if (input.areaRatio < 0.14) return 'candidate area ratio is too small for a card';
  if (Math.abs(input.aspectRatio - input.targetAspect) > 0.18) return 'candidate aspect ratio is not card-shaped';
  if (input.minPointDistance < input.minImageDimension * 0.1) return 'candidate corner points are too close together';
  return undefined;
}

function estimateCorners(points: Point[]): [Point, Point, Point, Point] {
  let topLeft = points[0];
  let topRight = points[0];
  let bottomRight = points[0];
  let bottomLeft = points[0];

  for (const point of points) {
    if (point.x + point.y < topLeft.x + topLeft.y) topLeft = point;
    if (point.x - point.y > topRight.x - topRight.y) topRight = point;
    if (point.x + point.y > bottomRight.x + bottomRight.y) bottomRight = point;
    if (point.x - point.y < bottomLeft.x - bottomLeft.y) bottomLeft = point;
  }

  return [topLeft, topRight, bottomRight, bottomLeft];
}

async function renderOutline(buffer: Buffer, corners: [Point, Point, Point, Point]): Promise<Buffer> {
  const polygon = corners.map((point) => `${point.x},${point.y}`).join(' ');
  const metadata = await sharp(buffer).metadata();
  const svg = `
    <svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">
      <polygon points="${polygon}" fill="none" stroke="#00e7ff" stroke-width="10" />
      ${corners.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="12" fill="#a02ee9" />`).join('')}
    </svg>
  `;
  return sharp(buffer).composite([{ input: Buffer.from(svg), blend: 'over' }]).jpeg({ quality: 92 }).toBuffer();
}

function solveHomography(src: Point[], dst: Point[]) {
  const a: number[][] = [];
  const b: number[] = [];

  for (let index = 0; index < 4; index += 1) {
    const s = src[index];
    const d = dst[index];
    a.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    a.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }

  const solution = gaussianSolve(a, b);
  return [
    solution[0], solution[1], solution[2],
    solution[3], solution[4], solution[5],
    solution[6], solution[7], 1
  ];
}

function gaussianSolve(matrix: number[][], vector: number[]) {
  const size = vector.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    [vector[column], vector[pivot]] = [vector[pivot], vector[column]];

    const divisor = matrix[column][column] || 1e-8;
    for (let j = column; j < size; j += 1) matrix[column][j] /= divisor;
    vector[column] /= divisor;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let j = column; j < size; j += 1) matrix[row][j] -= factor * matrix[column][j];
      vector[row] -= factor * vector[column];
    }
  }
  return vector;
}

function projectPoint(matrix: number[], x: number, y: number) {
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator
  };
}

function sampleBilinear(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, channels: number) {
  const clampedX = clamp(x, 0, width - 1);
  const clampedY = clamp(y, 0, height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const dx = clampedX - x0;
  const dy = clampedY - y0;

  const p00 = readPixel(data, width, channels, x0, y0);
  const p10 = readPixel(data, width, channels, x1, y0);
  const p01 = readPixel(data, width, channels, x0, y1);
  const p11 = readPixel(data, width, channels, x1, y1);

  return [0, 1, 2, 3].map((channel) => {
    const top = p00[channel] * (1 - dx) + p10[channel] * dx;
    const bottom = p01[channel] * (1 - dx) + p11[channel] * dx;
    return Math.round(top * (1 - dy) + bottom * dy);
  });
}

function readPixel(data: Uint8ClampedArray, width: number, channels: number, x: number, y: number) {
  const index = (y * width + x) * channels;
  return [
    data[index] ?? 0,
    data[index + 1] ?? data[index] ?? 0,
    data[index + 2] ?? data[index] ?? 0,
    data[index + 3] ?? 255
  ];
}

function getGray(data: Uint8Array, width: number, x: number, y: number) {
  return data[y * width + x] ?? 0;
}

function averageDistance(a: Point, b: Point, c: Point, d: Point) {
  return (distance(a, b) + distance(d, c)) / 2;
}

function averageVerticalDistance(a: Point, d: Point, b: Point, c: Point) {
  return (distance(a, d) + distance(b, c)) / 2;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function minPairwiseDistance(points: [Point, Point, Point, Point]) {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      min = Math.min(min, distance(points[i], points[j]));
    }
  }
  return min;
}

function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
