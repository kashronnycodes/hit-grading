import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { CardDetectionService } from '../services/cardDetectionService.js';
import { ConditionGradingService } from '../services/conditionGradingService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const detectBodySchema = z.object({
  selectedGame: z.string().optional(),
  selectedLanguage: z.string().optional(),
  game: z.string().optional(),
  language: z.string().optional(),
  debugMode: z.string().optional(),
  manualCrop: z.string().optional()
});

const manualCropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
  rotation: z.number().min(-20).max(20).optional()
});

const publicCardMatchSchema = z.object({
  id: z.string(),
  source: z.string(),
  game: z.string(),
  cardName: z.string(),
  cardNumber: z.string().optional(),
  rarity: z.string().optional(),
  language: z.string().optional(),
  setName: z.string().optional(),
  setSeries: z.string().optional(),
  setOrSeries: z.string().optional(),
  hp: z.string().optional(),
  imageUrl: z.string().optional(),
  confidenceLabel: z.enum(['Strong match found', 'Strong match', 'Fallback match found', 'Review needed', 'Low confidence']).optional(),
  confidenceScore: z.number().optional(),
  setCode: z.string().optional(),
  tcgplayerProductId: z.string().optional(),
  estimatedValue: z.object({
    amount: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    market: z.number().optional(),
    low: z.number().optional(),
    mid: z.number().optional(),
    high: z.number().optional(),
    currency: z.string().optional(),
    source: z.string().optional(),
    label: z.string().optional(),
    confidence: z.string().optional(),
    note: z.string().optional()
  }).optional()
});

const confirmBodySchema = z.object({
  scanId: z.string().min(1),
  confirmedCardId: z.string().min(1),
  confirmedSource: z.string().min(1),
  confirmedCandidate: publicCardMatchSchema.optional()
});

const correctBodySchema = z.object({
  scanId: z.string().min(1),
  cardName: z.string().optional(),
  cardNumber: z.string().optional(),
  setCode: z.string().optional(),
  language: z.string().optional()
});

export function createCardsRouter(cardDetectionService = new CardDetectionService(), conditionGradingService = new ConditionGradingService()) {
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
        console.log('[cards:detect] route hit');
        const parsed = detectBodySchema.parse(req.body);
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const frontImage = files?.image?.[0] ?? files?.frontImage?.[0];
        const backImage = files?.backImage?.[0];
        const selectedGame = parsed.selectedGame ?? parsed.game;
        const selectedLanguage = parsed.selectedLanguage ?? parsed.language ?? 'English';

        console.log('[cards:detect] files received', {
          frontImage: frontImage ? { name: frontImage.originalname, type: frontImage.mimetype, size: frontImage.size } : null,
          backImage: backImage ? { name: backImage.originalname, type: backImage.mimetype, size: backImage.size } : null
        });
        console.log('[cards:detect] req.body game/language received', { selectedGame, selectedLanguage });

        if (!frontImage) {
          console.log('[cards:detect] final response sent: missing image');
          return res.status(400).json({ error: 'An image file is required.' });
        }

        const result = await cardDetectionService.detect({
          imageBuffer: frontImage.buffer,
          filename: frontImage.originalname,
          mimeType: frontImage.mimetype,
          selectedGame,
          selectedLanguage,
          debugMode: parsed.debugMode === 'true',
          backImageBuffer: backImage?.buffer,
          manualCrop: parsed.manualCrop ? manualCropSchema.parse(JSON.parse(parsed.manualCrop)) : undefined
        });

        console.log('[cards:detect] final response sent', {
          status: result.status,
          cardName: result.detectedDetails?.cardName,
          alternatives: result.alternatives?.length ?? 0
        });
        return res.json(result);
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : 'Could not detect card. Please try a clearer image or select the card game manually.';
        console.error('[cards:detect] errors caught', message);
        return res.status(500).json({
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

  router.post('/correct', async (req, res, next) => {
    try {
      const parsed = correctBodySchema.parse(req.body);
      const updated = await cardDetectionService.correct(parsed);
      if (!updated) {
        res.status(404).json({ error: 'Scan record not found.' });
        return;
      }
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/grade-condition',
    upload.fields([
      { name: 'frontImage', maxCount: 1 },
      { name: 'backImage', maxCount: 1 }
    ]),
    async (req, res) => {
      try {
        console.log('[grade-condition] request received');
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const frontImage = files?.frontImage?.[0];
        const backImage = files?.backImage?.[0];
        console.log('[grade-condition] front image received', Boolean(frontImage));
        console.log('[grade-condition] back image received', Boolean(backImage));
        if (!frontImage) {
          return res.status(400).json({ error: 'A front image is required for condition grading.' });
        }

        const result = await conditionGradingService.analyze({
          frontImageBuffer: frontImage.buffer,
          backImageBuffer: backImage?.buffer,
          debugMode: req.body?.debugMode === 'true',
          identifiedCard: {
            cardName: req.body?.cardName,
            cardNumber: req.body?.cardNumber,
            setCode: req.body?.setCode,
            language: req.body?.language
          }
        });
        console.log('[grade-condition] quality scores', result.debug?.frontQualityScore, result.debug?.backQualityScore);
        console.log('[grade-condition] mode', result.mode);
        console.log('[grade-condition] estimated grade', result.estimatedGrade);
        console.log('[grade-condition] cap rules', result.capRulesApplied);
        return res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Condition grading failed.';
        return res.status(500).json({ error: message });
      }
    }
  );

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
