import type { CardScanResult } from '../types/cards.js';

export class GradingPrepService {
  prepare(scan: CardScanResult): CardScanResult['gradingPrep'] {
    return {
      status: scan.closestMatch ? 'ready' : 'needs-review',
      checklist: [
        'raw-image-saved',
        'normalized-image-saved',
        'ocr-text-saved',
        'card-candidates-ranked',
        'pricing-captured',
        'TODO: centering detection',
        'TODO: edge wear detection',
        'TODO: whitening detection',
        'TODO: scratches detection',
        'TODO: dents detection',
        'TODO: corner damage detection',
        'TODO: foil detection',
        'TODO: front/back scan correlation',
        'TODO: angled image scan support',
        'TODO: CLIP/DINOv2 embedding generation',
        'TODO: pgvector similarity indexing'
      ],
      futureEmbeddingKey: `${scan.scanId}-front`
    };
  }
}
