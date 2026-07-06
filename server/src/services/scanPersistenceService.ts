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
      officialMatch: payload.confirmedCandidate ?? existing.officialMatch ?? existing.closestMatch ?? null,
      alternatives: existing.alternatives.filter(
        (candidate) => candidate.id !== payload.confirmedCardId || candidate.source !== payload.confirmedSource
      ),
      identityStatus: 'identified',
      confirmedIdentity: true,
      userConfirmed: true,
      needsBetterPhoto: false,
      pricingEligible: true,
      identity: {
        status: 'identified',
        confirmedIdentity: true,
        needsUserConfirmation: false,
        needsBetterPhoto: false,
        pricingEligible: true,
        confidence: payload.confirmedCandidate?.confidenceScore ?? existing.identity?.confidence,
        reason: 'Card identity was manually confirmed by the user.',
        warnings: existing.identity?.warnings
      },
      reason: 'Card identity was manually confirmed by the user.',
      confirmedCardId: payload.confirmedCardId,
      confirmedSource: payload.confirmedSource,
      confirmedAt: new Date().toISOString(),
      needsUserConfirmation: false,
      detectionNotes: [
        ...(existing.detectionNotes ?? []),
        'Card identity was manually confirmed by the user.'
      ],
      debug: existing.debug
        ? {
            ...existing.debug,
            resultDecision: {
              ...(existing.debug.resultDecision ?? existing.identity),
              status: 'identified',
              confirmedIdentity: true,
              needsUserConfirmation: false,
              needsBetterPhoto: false,
              pricingEligible: true,
              confidence: payload.confirmedCandidate?.confidenceScore ?? existing.debug.resultDecision?.confidence,
              reason: 'Card identity was manually confirmed by the user.'
            }
          }
        : existing.debug
    };
    await this.save(updated);
    await this.saveTrainingRecord(updated, payload.confirmedCandidate);
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

  private async saveTrainingRecord(record: CardScanRecord, confirmedCandidate?: PublicCardMatch): Promise<void> {
    const trainingPath = path.join(env.SCAN_DATA_DIR, '..', 'training-confirmed', `${record.scanId}.json`);
    await writeJsonFile(trainingPath, {
      scanId: record.scanId,
      originalImagePath: record.rawImagePath,
      croppedImagePath: record.normalizedImagePath,
      backImagePath: record.backImagePath,
      ocrRawText: record.debug?.ocrText ?? record.debug?.identification?.rawOcrText ?? null,
      parsedOcrFields: record.detectedDetails,
      selectedOfficialCard: confirmedCandidate ?? record.officialMatch ?? record.closestMatch ?? null,
      conditionEstimate: record.conditionEstimate ?? null,
      gradingBreakdown: record.conditionEstimate?.breakdown ?? null,
      estimatedGrade: record.conditionEstimate?.estimatedGrade ?? null,
      gradingConfidence: record.conditionEstimate?.confidence ?? null,
      gradingWarnings: record.conditionEstimate?.warnings ?? [],
      gradingCapRules: record.conditionEstimate?.capRulesApplied ?? [],
      confidenceScore: (confirmedCandidate ?? record.officialMatch ?? record.closestMatch)?.confidenceScore ?? null,
      sourceUsed: record.confirmedSource ?? (confirmedCandidate ?? record.officialMatch ?? record.closestMatch)?.source ?? null,
      createdAt: record.createdAt,
      confirmedAt: record.confirmedAt,
      manuallyCorrected: Boolean(record.manuallyCorrected || record.correctedFields?.manuallyCorrected)
    });
  }
}
