import { config } from 'dotenv';
import { z } from 'zod';

config();

const booleanFlag = (defaultValue: boolean) => z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(8787),
  CLIENT_ORIGIN: z.string().default('http://127.0.0.1:5173'),
  PUBLIC_APP_ORIGIN: z.string().default('http://127.0.0.1:8787'),
  UPLOAD_DIR: z.string().default('server/storage/uploads'),
  NORMALIZED_DIR: z.string().default('server/storage/normalized'),
  SCAN_DATA_DIR: z.string().default('server/storage/scans'),
  OCR_DEBUG_MODE: z.coerce.boolean().default(false),
  OCR_DEBUG_DIR: z.string().default('server/storage/debug-ocr'),
  OCR_PROVIDER: z.enum(['auto', 'paddle', 'tesseract']).default('auto'),
  PADDLE_OCR_ENABLED: booleanFlag(true),
  PADDLE_OCR_ENDPOINT: z.string().optional().default(''),
  PADDLE_OCR_API_KEY: z.string().optional().default(''),
  PADDLE_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  TESSERACT_OCR_ENABLED: booleanFlag(false),
  PADDLE_OCR_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  POKEMON_TCG_API_KEY: z.string().optional().default(''),
  POKEMON_TCG_API_BASE_URL: z.string().default('https://api.pokemontcg.io/v2'),
  TCGDEX_BASE_URL: z.string().default('https://api.tcgdex.net/v2'),
  SCRYDEX_ENABLED: z.coerce.boolean().default(false),
  SCRYDEX_VISION_FALLBACK_ENABLED: booleanFlag(true),
  SCRYDEX_VISION_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  SCRYDEX_VISION_MATCH_THRESHOLD: z.coerce.number().min(0).default(0.85),
  SCRYDEX_API_BASE_URL: z.string().default('https://api.scrydex.com'),
  SCRYDEX_API_KEY: z.string().optional().default(''),
  SCRYDEX_TEAM_ID: z.string().optional().default(''),
  SCRYFALL_API_BASE_URL: z.string().default('https://api.scryfall.com'),
  YGOPRODECK_API_BASE_URL: z.string().default('https://db.ygoprodeck.com/api/v7'),
  LORCAST_API_BASE_URL: z.string().default('https://api.lorcast.com/v0'),
  OPTCG_API_BASE_URL: z.string().default('https://optcgapi.com/api'),
  API_TCG_BASE_URL: z.string().default('https://apitcg.com/api'),
  API_TCG_TOKEN: z.string().optional().default(''),
  ENABLE_FALLBACK_PRICE_ESTIMATES: z.coerce.boolean().default(true),
  ALLOW_INSECURE_DEV_TLS: z.coerce.boolean().default(false),
  SUPABASE_URL: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  SUPABASE_CARD_SCANS_TABLE: z.string().default('card_scans')
});

export const env = envSchema.parse(process.env);
