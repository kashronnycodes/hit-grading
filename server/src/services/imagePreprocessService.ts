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
  };
};

type PreprocessOptions = {
  manualCrop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export class ImagePreprocessService {
  constructor(private readonly cardBoundaryDetectionService = new CardBoundaryDetectionService()) {}

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

    if (options.manualCrop) {
      normalizedBuffer = await this.applyManualCrop(compressedInput, options.manualCrop);
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
    } else {
      const detected = await this.cardBoundaryDetectionService.detect(compressedInput);
      if (!detected || detected.confidence < 0.32) {
        throw new CardBoundaryDetectionError(
          'Could not find the card. Please place the card clearly inside the frame.',
          rawImagePath,
          this.toPublicUrl(rawImagePath, 'uploads'),
          originalWidth,
          originalHeight
        );
      }

      normalizedBuffer = await this.cardBoundaryDetectionService.warpCard(compressedInput, detected.corners);
      cardDetection = {
        corners: detected.corners,
        aspectRatio: detected.aspectRatio,
        confidence: detected.confidence,
        method: detected.method
      };

      if (env.OCR_DEBUG_MODE) {
        await sharp(detected.outlinedDebugBuffer).jpeg({ quality: 92 }).toFile(path.join(debugDir, 'detected_card_outline.jpg'));
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
      normalizedBuffer,
      diagnostics: {
        blurScore,
        glareScore,
        cropValid: Boolean(metadata.width && metadata.height && metadata.width > 200 && metadata.height > 200),
        normalizedWidth: metadata.width,
        normalizedHeight: metadata.height,
        originalWidth,
        originalHeight,
        cardDetection
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

  private toPublicUrl(filePath: string, routePrefix: 'uploads' | 'normalized'): string {
    return `/${routePrefix}/${path.basename(filePath)}`;
  }
}
