import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import type { CardScanRecord, CardScanResult, PublicCardMatch } from '../types/cards.js';
import { listFilesSorted, readJsonFile, writeJsonFile } from '../utils/files.js';

export class ScanPersistenceService {
  private supabase: SupabaseClient | null = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

  async save(record: CardScanRecord): Promise<void> {
    const filePath = this.getScanPath(record.scanId);
    await writeJsonFile(filePath, record);

    if (this.supabase) {
      await this.supabase.from(env.SUPABASE_CARD_SCANS_TABLE).upsert({
        scan_id: record.scanId,
        created_at: record.createdAt,
        payload: record,
        embedding: null
      });
      // TODO: add pgvector column population when CLIP/DINO embeddings are generated.
    }
  }

  async markConfirmed(
    scanId: string,
    payload: { confirmedCardId: string; confirmedSource: string; confirmedCandidate?: PublicCardMatch }
  ): Promise<CardScanRecord | null> {
    const existing = await this.getById(scanId);
    if (!existing) return null;
    const updated: CardScanRecord = {
      ...existing,
      closestMatch: payload.confirmedCandidate ?? existing.closestMatch,
      alternatives: existing.alternatives.filter(
        (candidate) => candidate.id !== payload.confirmedCardId || candidate.source !== payload.confirmedSource
      ),
      confirmedCardId: payload.confirmedCardId,
      confirmedSource: payload.confirmedSource,
      confirmedAt: new Date().toISOString(),
      needsUserConfirmation: false
    };
    await this.save(updated);
    return updated;
  }

  async getRecent(limit = 8): Promise<CardScanRecord[]> {
    const files = await listFilesSorted(env.SCAN_DATA_DIR);
    const selected = files.filter((name) => name.endsWith('.json')).slice(0, limit);
    const items = await Promise.all(
      selected.map((name) => readJsonFile<CardScanRecord | null>(path.join(env.SCAN_DATA_DIR, name), null))
    );
    return items.filter((item): item is CardScanRecord => Boolean(item));
  }

  async getById(scanId: string): Promise<CardScanRecord | null> {
    return readJsonFile<CardScanRecord | null>(this.getScanPath(scanId), null);
  }

  buildRecord(base: CardScanResult, extras: Partial<CardScanRecord> = {}): CardScanRecord {
    return {
      ...base,
      createdAt: new Date().toISOString(),
      alternativesFull: base.alternatives,
      ...extras
    };
  }

  private getScanPath(scanId: string): string {
    return path.join(env.SCAN_DATA_DIR, `${scanId}.json`);
  }
}
