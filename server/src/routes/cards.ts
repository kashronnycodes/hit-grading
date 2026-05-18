import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { CardDetectionService } from '../services/cardDetectionService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const detectBodySchema = z.object({
  selectedGame: z.string().optional(),
  selectedLanguage: z.string().optional(),
  manualCrop: z.string().optional()
});

const manualCropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1)
});

const publicCardMatchSchema = z.object({
  id: z.string(),
  source: z.string(),
  game: z.string(),
  cardName: z.string(),
  cardNumber: z.string().optional(),
  rarity: z.string().optional(),
  language: z.string().optional(),
  setOrSeries: z.string().optional(),
  imageUrl: z.string().optional(),
  estimatedValue: z.object({
    market: z.number().optional(),
    low: z.number().optional(),
    mid: z.number().optional(),
    high: z.number().optional(),
    currency: z.string().optional()
  }).optional()
});

const confirmBodySchema = z.object({
  scanId: z.string().min(1),
  confirmedCardId: z.string().min(1),
  confirmedSource: z.string().min(1),
  confirmedCandidate: publicCardMatchSchema.optional()
});

export function createCardsRouter(cardDetectionService = new CardDetectionService()) {
  const router = Router();

  router.post(
    '/detect',
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'frontImage', maxCount: 1 },
      { name: 'backImage', maxCount: 1 }
    ]),
    async (req, res, next) => {
      try {
        const parsed = detectBodySchema.parse(req.body);
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const frontImage = files?.image?.[0] ?? files?.frontImage?.[0];
        const backImage = files?.backImage?.[0];

        if (!frontImage) {
          res.status(400).json({ error: 'An image file is required.' });
          return;
        }

        const result = await cardDetectionService.detect({
          imageBuffer: frontImage.buffer,
          filename: frontImage.originalname,
          mimeType: frontImage.mimetype,
          selectedGame: parsed.selectedGame,
          selectedLanguage: parsed.selectedLanguage,
          backImageBuffer: backImage?.buffer,
          manualCrop: parsed.manualCrop ? manualCropSchema.parse(JSON.parse(parsed.manualCrop)) : undefined
        });

        res.json(result);
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : 'Could not detect card. Please try a clearer image or select the card game manually.';
        res.status(500).json({
          error: message,
          manualSearchSuggested: true
        });
      }
    }
  );

  router.post('/confirm', async (req, res, next) => {
    try {
      const parsed = confirmBodySchema.parse(req.body);
      const updated = await cardDetectionService.confirm(
        parsed.scanId,
        parsed.confirmedCardId,
        parsed.confirmedSource,
        parsed.confirmedCandidate
      );
      if (!updated) {
        res.status(404).json({ error: 'Scan record not found.' });
        return;
      }
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.get('/scans', async (_req, res, next) => {
    try {
      const scans = await cardDetectionService.getRecentScans();
      res.json(scans);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
