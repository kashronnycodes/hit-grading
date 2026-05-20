import path from 'node:path';
import sharp from 'sharp';
import { env } from '../config/env.js';
import { ensureDirectory } from '../utils/files.js';
import { CardBoundaryDetectionService } from './cardBoundaryDetectionService.js';

export class CardBoundaryDetectionError extends Error {
  constructor(
    message: string,
    public readonly rawImagePath: string,
    public readonly rawImageUrl: string,
    public readonly originalWidth: number,
    public readonly originalHeight: number
  ) {
    super(message);
    this.name = 'CardBoundaryDetectionError';
  }
}

export type PreprocessResult = {
  rawImagePath: string;
  normalizedImagePath: string;
  rawImageUrl: string;
  normalizedImageUrl: string;
  rawBuffer: Buffer;
  normalizedBuffer: Buffer;
  diagnostics: {
    blurScore: number;
    glareScore: number;
    cropValid: boolean;
    normalizedWidth: number;
    normalizedHeight: number;
    originalWidth: number;
    originalHeight: number;
    cardDetection?: {
      corners: Array<{ x: number; y: number }>;
      aspectRatio: number;
      confidence: number;
      method: string;
    };
    cropValidation?: CropValidation;
    crop?: {
      mode: 'auto' | 'fallback_center' | 'manual' | 'full_image';
      valid: boolean;
      confidence: number;
      coordinates?: NormalizedCrop;
      corners?: Array<{ x: number; y: number }>;
      warnings: string[];
    };
  };
};

type CropValidation = {
  cropWidth: number;
  cropHeight: number;
  cropArea: number;
  originalArea: number;
  cropAreaRatio: number;
  valid: boolean;
  reasons: string[];
};

type PreprocessOptions = {
  manualCrop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
  };
};

type NormalizedCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
};

export class ImagePreprocessService {
  constructor(private readonly cardBoundaryDetectionService = new CardBoundaryDetectionService()) {}

  async saveBackImage(scanId: string, imageBuffer: Buffer): Promise<{ path: string; url: string }> {
    await ensureDirectory(env.UPLOAD_DIR);
    const backImagePath = path.join(env.UPLOAD_DIR, `${scanId}-back.jpg`);
    const compressed = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    await sharp(compressed).jpeg({ quality: 92 }).toFile(backImagePath);
    return {
      path: backImagePath,
      url: this.toPublicUrl(backImagePath, 'uploads')
    };
  }

  async preprocess(scanId: string, imageBuffer: Buffer, options: PreprocessOptions = {}): Promise<PreprocessResult> {
    await ensureDirectory(env.UPLOAD_DIR);
    await ensureDirectory(env.NORMALIZED_DIR);
    await ensureDirectory(env.OCR_DEBUG_DIR);

    const rawImagePath = path.join(env.UPLOAD_DIR, `${scanId}.jpg`);
    const normalizedImagePath = path.join(env.NORMALIZED_DIR, `${scanId}.jpg`);
    const debugDir = path.join(env.OCR_DEBUG_DIR, scanId);

    const compressedInput = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();

    await sharp(compressedInput).jpeg({ quality: 92 }).toFile(rawImagePath);

    const originalMetadata = await sharp(compressedInput).metadata();
    const originalWidth = originalMetadata.width ?? 0;
    const originalHeight = originalMetadata.height ?? 0;

    if (env.OCR_DEBUG_MODE) {
      await ensureDirectory(debugDir);
      await sharp(compressedInput).jpeg({ quality: 92 }).toFile(path.join(debugDir, 'original_upload.jpg'));
    }

    let normalizedBuffer: Buffer;
    let cardDetection: PreprocessResult['diagnostics']['cardDetection'] | undefined;
    let cropValidation: CropValidation | undefined;
    let cropDiagnostics: NonNullable<PreprocessResult['diagnostics']['crop']>;

    if (options.manualCrop) {
      normalizedBuffer = await this.applyManualCrop(compressedInput, options.manualCrop);
      cropValidation = {
        cropWidth: Math.round(options.manualCrop.width * originalWidth),
        cropHeight: Math.round(options.manualCrop.height * originalHeight),
        cropArea: Math.round(options.manualCrop.width * originalWidth * options.manualCrop.height * originalHeight),
        originalArea: originalWidth * originalHeight,
        cropAreaRatio: Math.round(options.manualCrop.width * options.manualCrop.height * 1000) / 1000,
        valid: true,
        reasons: []
      };
      cardDetection = {
        corners: [
          { x: options.manualCrop.x * originalWidth, y: options.manualCrop.y * originalHeight },
          { x: (options.manualCrop.x + options.manualCrop.width) * originalWidth, y: options.manualCrop.y * originalHeight },
          { x: (options.manualCrop.x + options.manualCrop.width) * originalWidth, y: (options.manualCrop.y + options.manualCrop.height) * originalHeight },
          { x: options.manualCrop.x * originalWidth, y: (options.manualCrop.y + options.manualCrop.height) * originalHeight }
        ],
        aspectRatio: 734 / 1024,
        confidence: 1,
        method: 'manual-crop'
      };
      cropDiagnostics = {
        mode: 'manual',
        valid: true,
        confidence: 1,
        coordinates: clampNormalizedCrop(options.manualCrop),
        corners: cardDetection.corners,
        warnings: []
      };
    } else {
      const detected = await this.cardBoundaryDetectionService.detect(compressedInput);
      if (detected) {
        cropValidation = validateDetectedCrop(detected.corners, originalWidth, originalHeight);
        cardDetection = {
          corners: detected.corners,
          aspectRatio: detected.aspectRatio,
          confidence: detected.confidence,
          method: detected.method
        };

        if (env.OCR_DEBUG_MODE) {
          await sharp(detected.outlinedDebugBuffer).jpeg({ quality: 92 }).toFile(path.join(debugDir, 'detected_card_outline.jpg'));
        }

        if (detected.confidence >= 0.32 && cropValidation.valid) {
          normalizedBuffer = await this.cardBoundaryDetectionService.warpCard(compressedInput, detected.corners);
          cropDiagnostics = {
            mode: 'auto',
            valid: true,
            confidence: detected.confidence,
            coordinates: cornersToNormalizedCrop(detected.corners, originalWidth, originalHeight),
            corners: detected.corners,
            warnings: []
          };
        } else {
          const fallbackCrop = getFallbackCardCrop(originalWidth, originalHeight);
          normalizedBuffer = await this.applyManualCrop(compressedInput, fallbackCrop);
          cropDiagnostics = {
            mode: 'fallback_center',
            valid: true,
            confidence: 0.45,
            coordinates: fallbackCrop,
            corners: normalizedCropToCorners(fallbackCrop, originalWidth, originalHeight),
            warnings: [
              ...(cropValidation?.reasons ?? ['Detected crop was weak.']),
              'Automatic crop was weak, so a centered fallback crop was used.'
            ]
          };
        }
      } else {
        cropValidation = {
          cropWidth: 0,
          cropHeight: 0,
          cropArea: 0,
          originalArea: originalWidth * originalHeight,
          cropAreaRatio: 0,
          valid: false,
          reasons: ['No rectangular card boundary was detected.']
        };
        const fallbackCrop = getFallbackCardCrop(originalWidth, originalHeight);
        normalizedBuffer = await this.applyManualCrop(compressedInput, fallbackCrop);
        cropDiagnostics = {
          mode: 'fallback_center',
          valid: true,
          confidence: 0.35,
          coordinates: fallbackCrop,
          corners: normalizedCropToCorners(fallbackCrop, originalWidth, originalHeight),
          warnings: [
            'No rectangular card boundary was detected.',
            'A centered fallback crop was used.'
          ]
        };
      }
    }

    normalizedBuffer = await sharp(normalizedBuffer)
      .resize({ width: 734, height: 1024, fit: 'fill' })
      .modulate({ brightness: 1.02, saturation: 1.03 })
      .sharpen()
      .jpeg({ quality: 95 })
      .toBuffer();

    await sharp(normalizedBuffer).toFile(normalizedImagePath);
    if (env.OCR_DEBUG_MODE) {
      await sharp(normalizedBuffer).jpeg({ quality: 94 }).toFile(path.join(debugDir, 'perspective_corrected_card.jpg'));
    }

    const metadata = await sharp(normalizedBuffer).metadata();
    const stats = await sharp(normalizedBuffer).stats();

    const channelVariance = stats.channels.reduce((sum, channel) => sum + Math.pow(channel.stdev, 2), 0) / stats.channels.length;
    const blurScore = Math.round(channelVariance * 100) / 100;
    const glareScore = Math.round(
      ((stats.channels.reduce((sum, channel) => sum + channel.mean, 0) / stats.channels.length) / 255) * 100
    ) / 100;

    return {
      rawImagePath,
      normalizedImagePath,
      rawImageUrl: this.toPublicUrl(rawImagePath, 'uploads'),
      normalizedImageUrl: this.toPublicUrl(normalizedImagePath, 'normalized'),
      rawBuffer: compressedInput,
      normalizedBuffer,
      diagnostics: {
        blurScore,
        glareScore,
        cropValid: Boolean(cropValidation?.valid && metadata.width && metadata.height && metadata.width > 200 && metadata.height > 200),
        normalizedWidth: metadata.width,
        normalizedHeight: metadata.height,
        originalWidth,
        originalHeight,
        cardDetection,
        cropValidation,
        crop: cropDiagnostics
      }
    };
  }

  private async applyManualCrop(buffer: Buffer, crop: NonNullable<PreprocessOptions['manualCrop']>) {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 1;
    const height = metadata.height ?? 1;
    const left = Math.max(0, Math.floor(crop.x * width));
    const top = Math.max(0, Math.floor(crop.y * height));
    const cropWidth = Math.max(50, Math.floor(crop.width * width));
    const cropHeight = Math.max(70, Math.floor(crop.height * height));

    return sharp(buffer)
      .extract({
        left: Math.min(left, Math.max(0, width - cropWidth)),
        top: Math.min(top, Math.max(0, height - cropHeight)),
        width: Math.min(cropWidth, width),
        height: Math.min(cropHeight, height)
      })
      .jpeg({ quality: 94 })
      .toBuffer();
  }

  private normalizeFullFront(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize({ width: 734, height: 1024, fit: 'contain', background: '#0b1020' })
      .jpeg({ quality: 94 })
      .toBuffer();
  }

  private toPublicUrl(filePath: string, routePrefix: 'uploads' | 'normalized'): string {
    return `/${routePrefix}/${path.basename(filePath)}`;
  }
}

export function getFallbackCardCrop(imageWidth: number, imageHeight: number, aspectRatio = 0.716): NormalizedCrop {
  const width = Math.max(1, imageWidth);
  const height = Math.max(1, imageHeight);
  let cropHeight = height * 0.78;
  let cropWidth = cropHeight * aspectRatio;

  if (cropWidth > width * 0.95) {
    cropWidth = width * 0.9;
    cropHeight = cropWidth / aspectRatio;
  }

  cropHeight = Math.min(height * 0.9, Math.max(height * 0.65, cropHeight));
  cropWidth = Math.min(width * 0.95, cropHeight * aspectRatio);

  const x = (width - cropWidth) / 2 / width;
  const y = (height - cropHeight) / 2 / height;
  return clampNormalizedCrop({
    x,
    y,
    width: cropWidth / width,
    height: cropHeight / height
  });
}

function clampNormalizedCrop(crop: NormalizedCrop): NormalizedCrop {
  const width = clamp(crop.width, 0.2, 1);
  const height = clamp(crop.height, 0.2, 1);
  return {
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
    rotation: crop.rotation
  };
}

function cornersToNormalizedCrop(corners: Array<{ x: number; y: number }>, imageWidth: number, imageHeight: number): NormalizedCrop {
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const left = Math.max(0, Math.min(...xs));
  const top = Math.max(0, Math.min(...ys));
  const right = Math.min(imageWidth, Math.max(...xs));
  const bottom = Math.min(imageHeight, Math.max(...ys));
  return clampNormalizedCrop({
    x: left / imageWidth,
    y: top / imageHeight,
    width: (right - left) / imageWidth,
    height: (bottom - top) / imageHeight
  });
}

function normalizedCropToCorners(crop: NormalizedCrop, imageWidth: number, imageHeight: number): Array<{ x: number; y: number }> {
  const left = crop.x * imageWidth;
  const top = crop.y * imageHeight;
  const right = (crop.x + crop.width) * imageWidth;
  const bottom = (crop.y + crop.height) * imageHeight;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function validateDetectedCrop(corners: Array<{ x: number; y: number }>, originalWidth: number, originalHeight: number): CropValidation {
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const cropWidth = Math.max(...xs) - Math.min(...xs);
  const cropHeight = Math.max(...ys) - Math.min(...ys);
  const cropArea = cropWidth * cropHeight;
  const originalArea = originalWidth * originalHeight;
  const cropAreaRatio = originalArea ? cropArea / originalArea : 0;
  const sideLengths = [
    distance(corners[0], corners[1]),
    distance(corners[1], corners[2]),
    distance(corners[2], corners[3]),
    distance(corners[3], corners[0])
  ];
  const minSide = Math.min(...sideLengths);
  const reasons: string[] = [];

  if (cropWidth < originalWidth * 0.4) reasons.push('Detected crop width is less than 40% of the original image width.');
  if (cropHeight < originalHeight * 0.4) reasons.push('Detected crop height is less than 40% of the original image height.');
  if (cropArea < originalArea * 0.2) reasons.push('Detected crop area is less than 20% of the original image area.');
  if (minSide < Math.min(originalWidth, originalHeight) * 0.12) reasons.push('Detected crop coordinates are too close together.');

  return {
    cropWidth: Math.round(cropWidth),
    cropHeight: Math.round(cropHeight),
    cropArea: Math.round(cropArea),
    originalArea,
    cropAreaRatio: Math.round(cropAreaRatio * 1000) / 1000,
    valid: reasons.length === 0,
    reasons
  };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
