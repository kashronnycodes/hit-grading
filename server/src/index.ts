import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { createCardsRouter } from './routes/cards.js';
import { ensureDirectory } from './utils/files.js';

function parseAllowedOrigins(value: string) {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isPrivateLanDevOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const port = url.port;
    const isPrivateHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host);

    return url.protocol === 'http:' && isPrivateHost && ['5173', '5174', '4173'].includes(port);
  } catch {
    return false;
  }
}

function getPrivateIpv4Addresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .filter((entry) =>
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(entry.address) ||
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(entry.address) ||
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(entry.address)
      )
      .map((entry) => ({ name, address: entry.address }))
  );
}

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
  const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...parseAllowedOrigins(env.CLIENT_ORIGIN)
  ]);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin) || (env.NODE_ENV !== 'production' && isPrivateLanDevOrigin(origin))) {
          callback(null, true);
          return;
        }

        callback(new Error(`CORS origin not allowed: ${origin}`));
      }
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use('/uploads', express.static(path.resolve(process.cwd(), env.UPLOAD_DIR)));
  app.use('/normalized', express.static(path.resolve(process.cwd(), env.NORMALIZED_DIR)));
  if (env.OCR_DEBUG_MODE) {
    app.use('/debug-ocr', express.static(path.resolve(process.cwd(), env.OCR_DEBUG_DIR)));
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/network-info', (req, res) => {
    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      origin: req.headers.origin ?? null,
      host: req.headers.host ?? null,
      remoteAddress: req.socket.remoteAddress ?? null,
      forwardedFor: req.headers['x-forwarded-for'] ?? null
    });
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
    console.log(`API local health: http://127.0.0.1:${env.PORT}/api/health`);
    const lanAddresses = getPrivateIpv4Addresses();
    if (lanAddresses.length) {
      lanAddresses.forEach(({ name, address }) => {
        console.log(`API LAN health (${name}): http://${address}:${env.PORT}/api/health`);
      });
    } else {
      console.warn('No private LAN IPv4 address detected for API mobile testing.');
    }
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
