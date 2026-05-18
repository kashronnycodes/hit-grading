import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { createCardsRouter } from './routes/cards.js';
import { ensureDirectory } from './utils/files.js';

async function bootstrap() {
  await Promise.all([
    ensureDirectory(env.UPLOAD_DIR),
    ensureDirectory(env.NORMALIZED_DIR),
    ensureDirectory(env.SCAN_DATA_DIR),
    ensureDirectory(env.OCR_DEBUG_DIR)
  ]);

  const app = express();
  const projectRoot = process.cwd();
  const distDir = path.join(projectRoot, 'dist');
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/uploads', express.static(path.resolve(process.cwd(), env.UPLOAD_DIR)));
  app.use('/normalized', express.static(path.resolve(process.cwd(), env.NORMALIZED_DIR)));
  if (env.OCR_DEBUG_MODE) {
    app.use('/debug-ocr', express.static(path.resolve(process.cwd(), env.OCR_DEBUG_DIR)));
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/cards', createCardsRouter());

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Invalid request payload.',
        details: error.flatten()
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    res.status(500).json({ error: message });
  });

  app.listen(env.PORT, env.HOST, () => {
    console.log(`Card detection API listening on http://${env.HOST}:${env.PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
