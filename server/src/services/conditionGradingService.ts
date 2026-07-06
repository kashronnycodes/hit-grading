import sharp from 'sharp';
import type { ConditionCategoryResult, ConditionGradeResult, WhiteningCategoryResult } from '../types/cards.js';

type AnalyzeConditionInput = {
  frontImageBuffer: Buffer;
  backImageBuffer?: Buffer;
  frontCropValid?: boolean;
  debugMode?: boolean;
  identifiedCard?: {
    cardName?: string;
    cardNumber?: string;
    setCode?: string;
    language?: string;
  };
};

type Side = 'front' | 'back';

type ImageSample = {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
  blurScore: number;
  glareScore: number;
  brightness: number;
  qualityScore: number;
  qualityWarnings: string[];
  retakeTips: string[];
};

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CenteringAnalysis = {
  score: number;
  notes: string[];
  left: number;
  right: number;
  top: number;
  bottom: number;
  leftRightRatio: string;
  topBottomRatio: string;
  horizontalBalance: number;
  verticalBalance: number;
};

type CornerDetail = {
  name: string;
  score: number;
  detail: string;
  brightRatio: number;
  roughness: number;
  contrast: number;
};

type CornerAnalysis = {
  score: number;
  notes: string[];
  details: CornerDetail[];
  capRules: CapRule[];
};

type EdgeAnalysis = {
  score: number;
  notes: string[];
  details: Array<{ name: string; score: number; whiteRatio: number; roughness: number }>;
  capRules: CapRule[];
};

type SurfaceAnalysis = {
  score: number;
  notes: string[];
  glareRatio: number;
  darkSpotRatio: number;
  lineDefectScore: number;
  contrast: number;
  capRules: CapRule[];
};

type WhiteningAnalysis = {
  score: number;
  notes: string[];
  ratios: Array<{ name: string; ratio: number }>;
  worstRatio: number;
  avgRatio: number;
  capRules: CapRule[];
};

type PrintQualityAnalysis = {
  score: number;
  notes: string[];
  printLineScore: number;
  colorVariance: number;
  capRules: CapRule[];
};

type SideAnalysis = {
  side: Side;
  sample: ImageSample;
  centering: CenteringAnalysis;
  corners: CornerAnalysis;
  edges: EdgeAnalysis;
  surface: SurfaceAnalysis;
  whitening: WhiteningAnalysis;
  printQuality: PrintQualityAnalysis;
};

type CapRule = {
  maxGrade: number;
  reason: string;
};

const DISCLAIMER = 'AI-estimated raw condition grade, not an official PSA/BGS/CGC grade.';

export class ConditionGradingService {
  async analyze(input: AnalyzeConditionInput): Promise<ConditionGradeResult> {
    const front = analyzeSide(await loadImageSample(input.frontImageBuffer), 'front');
    const back = input.backImageBuffer ? analyzeSide(await loadImageSample(input.backImageBuffer), 'back') : null;
    const hasBack = Boolean(back);
    const qualityScores = [front.sample.qualityScore, back?.sample.qualityScore].filter((score): score is number => typeof score === 'number');
    const minQuality = Math.min(...qualityScores);
    const avgQuality = Math.round(average(qualityScores));
    const warnings = unique([
      ...front.sample.qualityWarnings.map((warning) => `Front: ${warning}`),
      ...(back ? back.sample.qualityWarnings.map((warning) => `Back: ${warning}`) : ['Back image needed for full condition estimate.']),
      ...(input.frontCropValid === false ? ['Front card crop was uncertain, so centering and edge estimates may be unreliable.'] : [])
    ]);
    const retakeTips = unique([
      ...front.sample.retakeTips,
      ...(back ? back.sample.retakeTips : ['Upload both front and back for full grading.']),
      ...(input.frontCropValid === false ? ['Take photo straight above the card.', 'Move closer while keeping the full card visible.'] : [])
    ]);

    const impossible = isImpossibleToAnalyze(front.sample) && (!back || isImpossibleToAnalyze(back.sample));
    if (impossible) {
      return {
        ...emptyConditionResult(),
        mode: 'unavailable',
        message: 'Condition estimate unavailable.',
        summary: 'The card is not visible enough to estimate condition. Retake clearer front and back photos.',
        warnings,
        retakeTips,
        photoQualityScore: avgQuality,
        gradingConfidence: 'low',
        conditionScore: null,
        debug: buildDebug(front, back, null, 'No grade calculated because the card was not visible enough.', {
          weighted: null,
          capped: null,
          confidencePenaltyReasons: getConfidencePenaltyReasons(minQuality, hasBack, warnings, input.frontCropValid !== false),
          actualDamageDetected: false,
          capsApplied: [],
          blurOrCropAffectedConfidenceOnly: true
        })
      };
    }

    const centering = combineCentering(front.centering, back?.centering ?? null);
    const corners = combineCorners(front.corners, back?.corners ?? null);
    const edges = combineCategory(front.edges, back?.edges ?? null, 'Edges');
    const surface = combineCategory(front.surface, back?.surface ?? null, 'Surface');
    const whitening = combineWhitening(back?.whitening ?? null);
    const printQuality = combinePrintQuality(front.printQuality, back?.printQuality ?? null);
    const weighted = weightedGrade({
      centering: centering.score,
      corners: corners.score,
      edges: edges.score,
      surface: surface.score,
      whitening: whitening.score
    });
    const capRules = collectCapRules(front, back);
    const actualDamageDetected = capRules.length > 0 || hasVisibleDamage(front) || (back ? hasVisibleDamage(back) : false);
    const cappedGrade = applyCaps(weighted, capRules);
    const estimatedGrade = roundToHalf(cappedGrade);
    const confidence = confidenceFromQuality(minQuality, hasBack, warnings.length, input.frontCropValid !== false);
    const confidencePenaltyReasons = getConfidencePenaltyReasons(minQuality, hasBack, warnings, input.frontCropValid !== false);
    const mode: ConditionGradeResult['mode'] = !hasBack
      ? 'partial_estimate'
      : confidence === 'low' || minQuality < 70
        ? 'low_confidence_estimate'
        : 'full_estimate';

    return {
      gradeAvailable: true,
      mode,
      estimatedGrade,
      photoQualityScore: avgQuality,
      gradingConfidence: confidence,
      conditionScore: estimatedGrade,
      gradeLabel: labelForGrade(estimatedGrade),
      confidence,
      disclaimer: DISCLAIMER,
      summary: buildSummary(estimatedGrade, confidence, centering, corners, edges, surface, whitening, printQuality, hasBack),
      breakdown: {
        centering,
        corners,
        edges,
        surface,
        whitening,
        printQuality
      },
      capRulesApplied: capRules.map((rule) => rule.reason),
      warnings: lowConfidenceWarning(confidence, warnings, actualDamageDetected),
      retakeTips,
      debug: buildDebug(front, back, estimatedGrade, finalFormula(weighted, capRules, estimatedGrade), {
        weighted,
        capped: cappedGrade,
        confidencePenaltyReasons,
        actualDamageDetected,
        capsApplied: capRules.map((rule) => rule.reason),
        blurOrCropAffectedConfidenceOnly: confidencePenaltyReasons.length > 0 && !actualDamageDetected
      })
    };
  }
}

function emptyConditionResult(): ConditionGradeResult {
  return {
    gradeAvailable: false,
    mode: 'unavailable',
    estimatedGrade: null,
    photoQualityScore: undefined,
    gradingConfidence: 'low',
    conditionScore: null,
    gradeLabel: 'Condition estimate unavailable',
    confidence: 'low',
    disclaimer: DISCLAIMER,
    summary: 'Condition estimate unavailable.',
    breakdown: {
      centering: { score: null, frontScore: null, backScore: null, notes: [] },
      corners: { score: null, frontScore: null, backScore: null, notes: [], cornerDetails: {} },
      edges: { score: null, frontScore: null, backScore: null, notes: [] },
      surface: { score: null, frontScore: null, backScore: null, notes: [] },
      whitening: { score: null, backScore: null, notes: [] },
      printQuality: { score: null, notes: [] }
    },
    capRulesApplied: [],
    warnings: [],
    retakeTips: []
  };
}

async function loadImageSample(buffer: Buffer): Promise<ImageSample> {
  const normalized = sharp(buffer)
    .rotate()
    .resize({ width: 734, height: 1024, fit: 'fill' })
    .removeAlpha();
  const { data, info } = await normalized.raw().toBuffer({ resolveWithObject: true });
  const brightness = averageLuma(data, info.channels);
  const blurScore = estimateSharpness(data, info.width, info.height, info.channels);
  const glareScore = ratioWhere(data, info.channels, (r, g, b) => luma(r, g, b) > 240);
  const quality = scoreImageQuality({ brightness, blurScore, glareScore });

  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    data,
    brightness,
    blurScore,
    glareScore,
    qualityScore: quality.score,
    qualityWarnings: quality.warnings,
    retakeTips: quality.retakeTips
  };
}

function analyzeSide(sample: ImageSample, side: Side): SideAnalysis {
  return {
    side,
    sample,
    centering: analyzeCentering(sample, side),
    corners: analyzeCorners(sample, side),
    edges: analyzeEdges(sample, side),
    surface: analyzeSurface(sample, side),
    whitening: analyzeWhitening(sample, side),
    printQuality: analyzePrintQuality(sample)
  };
}

function analyzeCentering(sample: ImageSample, side: Side): CenteringAnalysis {
  const left = estimateBorderInset(sample, 'left');
  const right = estimateBorderInset(sample, 'right');
  const top = estimateBorderInset(sample, 'top');
  const bottom = estimateBorderInset(sample, 'bottom');
  const leftRightRatio = ratioText(left, right);
  const topBottomRatio = ratioText(top, bottom);
  const horizontalSplit = splitImbalance(left, right);
  const verticalSplit = splitImbalance(top, bottom);
  const score = Math.min(scoreCenteringSplit(horizontalSplit, side), scoreCenteringSplit(verticalSplit, side));
  const notes = [];
  if (horizontalSplit > (side === 'front' ? 60 : 70)) notes.push(`Left/right centering looks off at roughly ${leftRightRatio}.`);
  if (verticalSplit > (side === 'front' ? 60 : 70)) notes.push(`Top/bottom centering looks off at roughly ${topBottomRatio}.`);
  if (!notes.length) notes.push(`Centering looks balanced at roughly ${leftRightRatio} left/right and ${topBottomRatio} top/bottom.`);
  return {
    score,
    notes,
    left,
    right,
    top,
    bottom,
    leftRightRatio,
    topBottomRatio,
    horizontalBalance: balance(left, right),
    verticalBalance: balance(top, bottom)
  };
}

function analyzeCorners(sample: ImageSample, side: Side): CornerAnalysis {
  const regions: Record<string, Region> = {
    topLeft: { x: 0, y: 0, width: sample.width * 0.15, height: sample.height * 0.11 },
    topRight: { x: sample.width * 0.85, y: 0, width: sample.width * 0.15, height: sample.height * 0.11 },
    bottomLeft: { x: 0, y: sample.height * 0.89, width: sample.width * 0.15, height: sample.height * 0.11 },
    bottomRight: { x: sample.width * 0.85, y: sample.height * 0.89, width: sample.width * 0.15, height: sample.height * 0.11 }
  };
  const details = Object.entries(regions).map(([name, region]) => {
    const brightRatio = regionRatio(sample, region, (r, g, b) => isWhitePixel(r, g, b, side));
    const roughness = regionEdgeEnergy(sample, region);
    const contrast = regionContrast(sample, region);
    const visibleWhitening = Math.max(0, brightRatio - (side === 'back' ? 0.045 : 0.035));
    const visibleRoughness = Math.max(0, roughness - 34);
    const visibleContrast = Math.max(0, contrast - 86);
    const score = clampScore(9.6 - visibleWhitening * (side === 'back' ? 36 : 28) - visibleRoughness / 28 - visibleContrast / 34);
    return {
      name,
      score,
      brightRatio,
      roughness,
      contrast,
      detail: cornerDetailText(score, brightRatio, roughness)
    };
  });
  const notes = details.filter((entry) => entry.score < 8.8).map((entry) => `${labelKey(entry.name)} corner: ${entry.detail}`);
  if (!notes.length) notes.push('Corners look sharp with no obvious heavy wear in this image.');
  return {
    score: roundOne(average(details.map((entry) => entry.score))),
    notes,
    details,
    capRules: cornerCaps(details, side)
  };
}

function analyzeEdges(sample: ImageSample, side: Side): EdgeAnalysis {
  const strips = edgeStrips(sample);
  const details = Object.entries(strips).map(([name, region]) => {
    const whiteRatio = regionRatio(sample, region, (r, g, b) => isWhitePixel(r, g, b, side));
    const roughness = regionEdgeEnergy(sample, region);
    const visibleWhitening = Math.max(0, whiteRatio - (side === 'back' ? 0.045 : 0.035));
    const visibleRoughness = Math.max(0, roughness - 34);
    const score = clampScore(9.5 - visibleWhitening * (side === 'back' ? 40 : 28) - visibleRoughness / 34);
    return { name, whiteRatio, roughness, score };
  });
  const notes = details.filter((entry) => entry.score < 8.6).map((entry) => `${labelKey(entry.name)} edge may show whitening, chips, or rough cutting.`);
  if (!notes.length) notes.push('Edges look clean at this resolution.');
  return {
    score: roundOne(average(details.map((entry) => entry.score))),
    notes,
    details,
    capRules: edgeCaps(details, side)
  };
}

function analyzeSurface(sample: ImageSample, side: Side): SurfaceAnalysis {
  const region = { x: sample.width * 0.1, y: sample.height * 0.12, width: sample.width * 0.8, height: sample.height * 0.74 };
  const glareRatio = regionRatio(sample, region, (r, g, b) => luma(r, g, b) > 242);
  const darkSpotRatio = regionRatio(sample, region, (r, g, b) => luma(r, g, b) < 30);
  const contrast = regionContrast(sample, region);
  const lineDefectScore = regionLineEnergy(sample, region);
  const visibleGlare = Math.max(0, glareRatio - 0.08);
  const visibleDarkMarks = Math.max(0, darkSpotRatio - 0.045);
  const visibleLines = Math.max(0, lineDefectScore - 36);
  const visibleContrast = Math.max(0, contrast - 102);
  const score = clampScore(9.3 - visibleGlare * 16 - visibleDarkMarks * 28 - visibleLines / 30 - visibleContrast / 48);
  const notes = [];
  if (glareRatio > 0.025) notes.push('Glare may be hiding scratches, dents, or surface marks.');
  if (darkSpotRatio > 0.025) notes.push('Dark marks, stains, or shadows were detected on the surface.');
  if (lineDefectScore > 28) notes.push('Line-like marks may indicate scratches, print lines, or lighting artifacts.');
  if (sample.blurScore < 18) notes.push('Surface issues may be hidden by lighting or blur.');
  if (!notes.length) notes.push(`No major ${side} surface issues detected by image analysis.`);
  return {
    score: roundOne(score),
    notes,
    glareRatio,
    darkSpotRatio,
    lineDefectScore,
    contrast,
    capRules: surfaceCaps({ glareRatio, darkSpotRatio, lineDefectScore, contrast }, side)
  };
}

function analyzeWhitening(sample: ImageSample, side: Side): WhiteningAnalysis {
  const strips = edgeStrips(sample, 0.07);
  const ratios = Object.entries(strips).map(([name, region]) => ({
    name,
    ratio: regionRatio(sample, region, (r, g, b) => isWhitePixel(r, g, b, side))
  }));
  const worstRatio = Math.max(...ratios.map((entry) => entry.ratio));
  const avgRatio = average(ratios.map((entry) => entry.ratio));
  const visibleWorst = Math.max(0, worstRatio - (side === 'back' ? 0.04 : 0.035));
  const visibleAverage = Math.max(0, avgRatio - (side === 'back' ? 0.025 : 0.02));
  const score = clampScore(9.6 - visibleWorst * (side === 'back' ? 42 : 24) - visibleAverage * (side === 'back' ? 22 : 12));
  const notes = ratios.filter((entry) => entry.ratio > 0.022).map((entry) => `${labelKey(entry.name)} border shows possible whitening.`);
  if (sample.glareScore > 0.08) notes.push('Whitening confidence is lower because glare is present.');
  if (!notes.length) notes.push(side === 'back' ? 'Back border whitening appears limited in this image.' : 'Front-side whitening appears limited in this image.');
  return {
    score: roundOne(score),
    notes,
    ratios,
    worstRatio,
    avgRatio,
    capRules: whiteningCaps(worstRatio, avgRatio)
  };
}

function analyzePrintQuality(sample: ImageSample): PrintQualityAnalysis {
  const region = { x: sample.width * 0.12, y: sample.height * 0.1, width: sample.width * 0.76, height: sample.height * 0.78 };
  const printLineScore = regionLineEnergy(sample, region);
  const colorVariance = regionContrast(sample, region);
  const score = clampScore(9.3 - Math.max(0, printLineScore - 38) / 36 - Math.max(0, colorVariance - 105) / 58);
  const notes = [];
  if (sample.blurScore < 16) notes.push('Print quality cannot be confidently judged because focus is soft.');
  if (printLineScore > 30) notes.push('Possible print lines, scratches, or repeated line artifacts detected.');
  if (colorVariance > 92) notes.push('High color variation may indicate print defects or uneven lighting.');
  if (!notes.length) notes.push('No obvious print/visual defects detected.');
  return {
    score: roundOne(score),
    notes,
    printLineScore,
    colorVariance,
    capRules: printQualityCaps(printLineScore)
  };
}

function combineCentering(front: CenteringAnalysis, back: CenteringAnalysis | null): ConditionCategoryResult {
  return {
    score: combineScores(front.score, back?.score ?? null),
    frontScore: front.score,
    backScore: back?.score ?? null,
    notes: [...front.notes.map((note) => `Front centering: ${note}`), ...(back ? back.notes.map((note) => `Back centering: ${note}`) : ['Back centering not measured because no back image was uploaded.'])].slice(0, 5)
  };
}

function combineCorners(front: CornerAnalysis, back: CornerAnalysis | null): ConditionGradeResult['breakdown']['corners'] {
  return {
    score: combineScores(front.score, back?.score ?? null),
    frontScore: front.score,
    backScore: back?.score ?? null,
    notes: [...front.notes.map((note) => `Front corners: ${note}`), ...(back ? back.notes.map((note) => `Back corners: ${note}`) : ['Back corners not measured because no back image was uploaded.'])].slice(0, 6),
    cornerDetails: {
      ...cornerDetailsForSide(front.details, 'front'),
      ...(back ? cornerDetailsForSide(back.details, 'back') : {})
    }
  };
}

function combineCategory(front: { score: number; notes: string[] }, back: { score: number; notes: string[] } | null, label: string): ConditionCategoryResult {
  return {
    score: combineScores(front.score, back?.score ?? null),
    frontScore: front.score,
    backScore: back?.score ?? null,
    notes: [
      ...front.notes.map((note) => `Front ${label.toLowerCase()}: ${note}`),
      ...(back ? back.notes.map((note) => `Back ${label.toLowerCase()}: ${note}`) : [`Back ${label.toLowerCase()} not measured because no back image was uploaded.`])
    ].slice(0, 5)
  };
}

function combineWhitening(back: WhiteningAnalysis | null): WhiteningCategoryResult {
  if (!back) {
    return {
      score: null,
      backScore: null,
      notes: ['Back image needed to estimate whitening reliably.']
    };
  }
  return {
    score: back.score,
    backScore: back.score,
    notes: back.notes
  };
}

function combinePrintQuality(front: PrintQualityAnalysis, back: PrintQualityAnalysis | null): ConditionGradeResult['breakdown']['printQuality'] {
  return {
    score: combineScores(front.score, back?.score ?? null),
    notes: [...front.notes.map((note) => `Front print/visual quality: ${note}`), ...(back ? back.notes.map((note) => `Back print/visual quality: ${note}`) : ['Back print/visual quality not measured because no back image was uploaded.'])].slice(0, 5)
  };
}

function weightedGrade(scores: { centering: number | null; corners: number | null; edges: number | null; surface: number | null; whitening: number | null }): number {
  const weights = { centering: 0.3, corners: 0.25, edges: 0.2, surface: 0.2, whitening: 0.05 };
  let total = 0;
  let weightTotal = 0;
  for (const key of Object.keys(weights) as Array<keyof typeof weights>) {
    const score = scores[key];
    if (score === null) continue;
    total += score * weights[key];
    weightTotal += weights[key];
  }
  return weightTotal ? total / weightTotal : 0;
}

function collectCapRules(front: SideAnalysis, back: SideAnalysis | null): CapRule[] {
  return [
    ...front.corners.capRules.map((rule) => sideRule(rule, 'Front')),
    ...front.edges.capRules.map((rule) => sideRule(rule, 'Front')),
    ...front.surface.capRules.map((rule) => sideRule(rule, 'Front')),
    ...front.printQuality.capRules.map((rule) => sideRule(rule, 'Front')),
    ...(back ? [
      ...back.corners.capRules.map((rule) => sideRule(rule, 'Back')),
      ...back.edges.capRules.map((rule) => sideRule(rule, 'Back')),
      ...back.surface.capRules.map((rule) => sideRule(rule, 'Back')),
      ...back.whitening.capRules.map((rule) => sideRule(rule, 'Back')),
      ...back.printQuality.capRules.map((rule) => sideRule(rule, 'Back'))
    ] : [])
  ];
}

function applyCaps(score: number, caps: CapRule[]): number {
  if (!caps.length) return score;
  return Math.min(score, ...caps.map((rule) => rule.maxGrade));
}

function buildSummary(
  grade: number,
  confidence: 'low' | 'medium' | 'high',
  centering: ConditionCategoryResult,
  corners: ConditionCategoryResult,
  edges: ConditionCategoryResult,
  surface: ConditionCategoryResult,
  whitening: WhiteningCategoryResult,
  printQuality: ConditionGradeResult['breakdown']['printQuality'],
  hasBack: boolean
): string {
  const reasons = [
    centering.score !== null && centering.score < 8.5 ? 'centering appears imperfect' : null,
    corners.score !== null && corners.score < 8.5 ? 'corners show possible wear' : null,
    edges.score !== null && edges.score < 8.5 ? 'edges show possible wear or whitening' : null,
    surface.score !== null && surface.score < 8.5 ? 'surface check found possible visual issues' : null,
    whitening.score !== null && whitening.score < 8.8 ? 'back whitening may be present' : null,
    printQuality.score !== null && printQuality.score < 8.5 ? 'print/visual quality may have defects or uncertain focus' : null
  ].filter(Boolean);
  const base = `Estimated raw condition is ${grade}/10 (${labelForGrade(grade)}) with ${confidence} confidence.`;
  if (confidence === 'low' && grade >= 8 && !reasons.length) {
    return `This card appears to be in nice condition from the visible photo, but the estimate is low-confidence because image quality or crop limits surface and edge inspection.${hasBack ? '' : ' Upload the back image for a fuller estimate.'}`;
  }
  if (confidence === 'low' && grade >= 8) {
    return `This card appears to be in nice condition from the visible photo, but the estimate is low-confidence. Main visible/uncertain points: ${reasons.slice(0, 3).join(', ')}.${hasBack ? '' : ' Upload the back image for a fuller estimate.'}`;
  }
  const detail = reasons.length ? ` Visible condition factors: ${reasons.slice(0, 3).join(', ')}.` : ' No major flaws were detected by this image analysis.';
  return `${base}${detail}${hasBack ? '' : ' Upload the back image for a fuller estimate.'}`;
}

function buildDebug(
  front: SideAnalysis,
  back: SideAnalysis | null,
  estimatedGrade: number | null,
  formula: string,
  extras: {
    weighted: number | null;
    capped: number | null;
    confidencePenaltyReasons: string[];
    actualDamageDetected: boolean;
    capsApplied: string[];
    blurOrCropAffectedConfidenceOnly: boolean;
  }
): ConditionGradeResult['debug'] {
  return {
    frontQualityScore: front.sample.qualityScore,
    backQualityScore: back?.sample.qualityScore,
    frontCardRectangle: rectangleDebug(front.sample),
    backCardRectangle: back ? rectangleDebug(back.sample) : undefined,
    centeringRatios: {
      frontLeftRight: front.centering.leftRightRatio,
      frontTopBottom: front.centering.topBottomRatio,
      backLeftRight: back?.centering.leftRightRatio,
      backTopBottom: back?.centering.topBottomRatio,
      front: pickCenteringDebug(front.centering),
      back: back ? pickCenteringDebug(back.centering) : undefined
    },
    blurScores: {
      front: front.sample.blurScore,
      back: back?.sample.blurScore
    },
    glareScores: {
      front: front.sample.glareScore,
      back: back?.sample.glareScore
    },
    whiteningMetrics: back ? back.whitening : undefined,
    edgeMetrics: {
      front: front.edges.details,
      back: back?.edges.details
    },
    cornerMetrics: {
      front: front.corners.details,
      back: back?.corners.details
    },
    surfaceMetrics: {
      front: front.surface,
      back: back?.surface
    },
    conditionScoreBeforeCaps: extras.weighted === null ? null : roundOne(extras.weighted),
    conditionScoreAfterCaps: extras.capped === null ? null : roundOne(extras.capped),
    confidencePenaltyReasons: extras.confidencePenaltyReasons,
    actualDamageDetected: extras.actualDamageDetected,
    capsApplied: extras.capsApplied,
    blurOrCropAffectedConfidenceOnly: extras.blurOrCropAffectedConfidenceOnly,
    finalFormula: estimatedGrade === null ? 'No grade calculated.' : formula
  };
}

function scoreImageQuality(metrics: { brightness: number; blurScore: number; glareScore: number }): { score: number; warnings: string[]; retakeTips: string[] } {
  let score = 100;
  const warnings: string[] = [];
  const retakeTips: string[] = [];

  if (metrics.blurScore < 8) {
    score -= 45;
    warnings.push('Image is very blurry.');
    retakeTips.push('Use sharper focus.');
  } else if (metrics.blurScore < 14) {
    score -= 28;
    warnings.push('Image appears blurry.');
    retakeTips.push('Use sharper focus.');
  } else if (metrics.blurScore < 20) {
    score -= 12;
    warnings.push('Image is a little soft.');
    retakeTips.push('Keep the phone steady.');
  }

  if (metrics.glareScore > 0.18) {
    score -= 35;
    warnings.push('Strong glare or overexposure detected.');
    retakeTips.push('Avoid glare from lights.');
  } else if (metrics.glareScore > 0.09) {
    score -= 20;
    warnings.push('Glare may hide surface flaws.');
    retakeTips.push('Avoid glare from lights.');
  } else if (metrics.glareScore > 0.045) {
    score -= 8;
    warnings.push('Mild glare detected.');
  }

  if (metrics.brightness < 25) {
    score -= 35;
    warnings.push('Image is very dark.');
    retakeTips.push('Use brighter, even lighting.');
  } else if (metrics.brightness < 45) {
    score -= 18;
    warnings.push('Image appears dark.');
    retakeTips.push('Use brighter, even lighting.');
  } else if (metrics.brightness > 225) {
    score -= 15;
    warnings.push('Image appears overexposed.');
    retakeTips.push('Avoid direct light on the card.');
  }

  retakeTips.push('Use a plain dark background.', 'Take photo straight above the card.', 'Move closer while keeping the full card visible.');
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    warnings,
    retakeTips: unique(retakeTips)
  };
}

function isImpossibleToAnalyze(sample: ImageSample): boolean {
  return sample.qualityScore < 25 && (sample.blurScore < 5 || sample.brightness < 18 || sample.glareScore > 0.32);
}

function confidenceFromQuality(minQuality: number, hasBack: boolean, warningCount: number, cropValid: boolean): 'low' | 'medium' | 'high' {
  if (!hasBack || !cropValid || minQuality < 45 || warningCount >= 4) return 'low';
  if (minQuality < 70 || warningCount > 0) return 'medium';
  return 'high';
}

function lowConfidenceWarning(confidence: 'low' | 'medium' | 'high', warnings: string[], actualDamageDetected: boolean): string[] {
  return confidence === 'low'
    ? unique([
        actualDamageDetected
          ? 'Low-confidence estimate. Visible condition issues may be present, but retake for better accuracy.'
          : 'Low-confidence estimate because the photo/crop limits inspection, not because major damage was detected.',
        'Retake with sharper lighting for a more accurate grade.',
        'Some surface damage may be hidden by blur or glare.',
        ...warnings
      ])
    : warnings;
}

function getConfidencePenaltyReasons(minQuality: number, hasBack: boolean, warnings: string[], cropValid: boolean): string[] {
  return [
    !hasBack ? 'Back image missing.' : null,
    !cropValid ? 'Crop/card boundary was uncertain.' : null,
    minQuality < 45 ? 'Photo quality is low.' : null,
    minQuality >= 45 && minQuality < 70 ? 'Photo quality is moderate.' : null,
    ...warnings.filter((warning) => /blur|glare|dark|crop|back image/i.test(warning))
  ].filter(Boolean) as string[];
}

function hasVisibleDamage(side: SideAnalysis): boolean {
  return Boolean(
    side.corners.details.some((entry) => entry.brightRatio > 0.065 || entry.score < 8) ||
    side.edges.details.some((entry) => entry.whiteRatio > 0.085 || entry.score < 8) ||
    side.surface.darkSpotRatio > 0.08 ||
    side.surface.lineDefectScore > 46 ||
    side.whitening.worstRatio > 0.09 ||
    side.printQuality.printLineScore > 52
  );
}

function cornerDetailsForSide(details: CornerDetail[], side: Side): ConditionGradeResult['breakdown']['corners']['cornerDetails'] {
  const prefix = side === 'front' ? 'front' : 'back';
  return Object.fromEntries(
    details.map((entry) => [`${prefix}${labelKey(entry.name).replace(/\s+/g, '')}`, entry.detail])
  );
}

function cornerDetailText(score: number, brightRatio: number, roughness: number): string {
  if (score <= 6.5) return 'heavy wear, bending, or peeling suspected';
  if (score <= 7.5) return 'multiple visible corner issues suspected';
  if (brightRatio > 0.055) return 'small whitening dot or color loss suspected';
  if (roughness > 42) return 'slight softness or rough corner edge suspected';
  return 'sharp/clean';
}

function cornerCaps(details: CornerDetail[], side: Side): CapRule[] {
  const caps: CapRule[] = [];
  if (details.some((entry) => entry.brightRatio > 0.16 || entry.score <= 6.1)) caps.push({ maxGrade: 6.5, reason: `${side} heavy corner wear suspected: max grade 6.5.` });
  else if (details.some((entry) => entry.brightRatio > 0.11 || entry.score <= 7.0)) caps.push({ maxGrade: 7, reason: `${side} obvious bent/soft corner suspected: max grade 7.` });
  else if (details.some((entry) => entry.brightRatio > 0.065 && entry.score < 9)) caps.push({ maxGrade: 9, reason: `${side} small corner whitening dot suspected: max grade 9.` });
  return caps;
}

function edgeCaps(details: EdgeAnalysis['details'], side: Side): CapRule[] {
  const caps: CapRule[] = [];
  const whiteningEdges = details.filter((entry) => entry.whiteRatio > 0.085).length;
  if (details.some((entry) => entry.whiteRatio > 0.18)) caps.push({ maxGrade: 7.5, reason: `${side} heavy edge whitening/chipping suspected: max grade 7.5.` });
  else if (whiteningEdges >= 2) caps.push({ maxGrade: 8.5, reason: `${side} multiple visible edge whitening marks suspected: max grade 8.5.` });
  if (details.some((entry) => entry.roughness > 58)) caps.push({ maxGrade: 6, reason: `${side} rough edge or possible layer separation suspected: max grade 6.` });
  return caps;
}

function surfaceCaps(metrics: Pick<SurfaceAnalysis, 'glareRatio' | 'darkSpotRatio' | 'lineDefectScore' | 'contrast'>, side: Side): CapRule[] {
  const caps: CapRule[] = [];
  if (metrics.lineDefectScore > 68) caps.push({ maxGrade: 5, reason: `${side} clear crease-like line detected: max grade 5.` });
  else if (metrics.lineDefectScore > 54) caps.push({ maxGrade: 7, reason: `${side} heavy scratches or print lines suspected: max grade 7.` });
  if (metrics.darkSpotRatio > 0.12) caps.push({ maxGrade: 6, reason: `${side} stain or dark surface mark suspected: max grade 6.` });
  if (metrics.contrast > 150) caps.push({ maxGrade: 7, reason: `${side} dent/pressure-mark-like contrast pattern suspected: max grade 7.` });
  return caps;
}

function whiteningCaps(worstRatio: number, avgRatio: number): CapRule[] {
  if (worstRatio > 0.16 || avgRatio > 0.09) return [{ maxGrade: 7.5, reason: 'Heavy back whitening suspected: max grade 7.5.' }];
  if (worstRatio > 0.09 || avgRatio > 0.055) return [{ maxGrade: 8.5, reason: 'Multiple back whitening marks suspected: max grade 8.5.' }];
  return [];
}

function printQualityCaps(printLineScore: number): CapRule[] {
  if (printLineScore > 62) return [{ maxGrade: 8.5, reason: 'Strong print-line or visual defect pattern suspected: max grade 8.5.' }];
  if (printLineScore > 52) return [{ maxGrade: 9, reason: 'Minor print-line or visual defect pattern suspected: max grade 9.' }];
  return [];
}

function estimateBorderInset(sample: ImageSample, side: 'left' | 'right' | 'top' | 'bottom'): number {
  const maxDistance = side === 'left' || side === 'right' ? Math.floor(sample.width * 0.18) : Math.floor(sample.height * 0.14);
  const edgeColor = sideAverageLuma(sample, side, 3);
  for (let offset = 4; offset < maxDistance; offset += 2) {
    const current = sideLineAverageLuma(sample, side, offset);
    if (Math.abs(current - edgeColor) > 16) return offset;
  }
  return maxDistance;
}

function sideAverageLuma(sample: ImageSample, side: 'left' | 'right' | 'top' | 'bottom', thickness: number): number {
  const region = side === 'left'
    ? { x: 0, y: 0, width: thickness, height: sample.height }
    : side === 'right'
      ? { x: sample.width - thickness, y: 0, width: thickness, height: sample.height }
      : side === 'top'
        ? { x: 0, y: 0, width: sample.width, height: thickness }
        : { x: 0, y: sample.height - thickness, width: sample.width, height: thickness };
  return regionAverageLuma(sample, region);
}

function sideLineAverageLuma(sample: ImageSample, side: 'left' | 'right' | 'top' | 'bottom', offset: number): number {
  const region = side === 'left'
    ? { x: offset, y: 0, width: 2, height: sample.height }
    : side === 'right'
      ? { x: sample.width - offset - 2, y: 0, width: 2, height: sample.height }
      : side === 'top'
        ? { x: 0, y: offset, width: sample.width, height: 2 }
        : { x: 0, y: sample.height - offset - 2, width: sample.width, height: 2 };
  return regionAverageLuma(sample, region);
}

function edgeStrips(sample: ImageSample, thicknessRatio = 0.048): Record<string, Region> {
  const xThickness = Math.max(8, Math.floor(sample.width * thicknessRatio));
  const yThickness = Math.max(10, Math.floor(sample.height * thicknessRatio));
  return {
    left: { x: 0, y: 0, width: xThickness, height: sample.height },
    right: { x: sample.width - xThickness, y: 0, width: xThickness, height: sample.height },
    top: { x: 0, y: 0, width: sample.width, height: yThickness },
    bottom: { x: 0, y: sample.height - yThickness, width: sample.width, height: yThickness }
  };
}

function regionAverageLuma(sample: ImageSample, region: Region): number {
  let sum = 0;
  let count = 0;
  walkRegion(sample, region, (r, g, b) => {
    sum += luma(r, g, b);
    count += 1;
  }, 3);
  return count ? sum / count : 0;
}

function regionRatio(sample: ImageSample, region: Region, predicate: (r: number, g: number, b: number) => boolean): number {
  let hits = 0;
  let count = 0;
  walkRegion(sample, region, (r, g, b) => {
    if (predicate(r, g, b)) hits += 1;
    count += 1;
  }, 2);
  return count ? hits / count : 0;
}

function regionContrast(sample: ImageSample, region: Region): number {
  const values: number[] = [];
  walkRegion(sample, region, (r, g, b) => {
    values.push(luma(r, g, b));
  }, 5);
  return stdev(values);
}

function regionEdgeEnergy(sample: ImageSample, region: Region): number {
  let total = 0;
  let count = 0;
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(sample.width - 2, Math.floor(region.x + region.width));
  const bottom = Math.min(sample.height - 2, Math.floor(region.y + region.height));
  for (let y = top; y < bottom; y += 4) {
    for (let x = left; x < right; x += 4) {
      total += Math.abs(pixelLuma(sample, x, y) - pixelLuma(sample, x + 1, y)) + Math.abs(pixelLuma(sample, x, y) - pixelLuma(sample, x, y + 1));
      count += 2;
    }
  }
  return count ? total / count : 0;
}

function regionLineEnergy(sample: ImageSample, region: Region): number {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(sample.width - 3, Math.floor(region.x + region.width));
  const bottom = Math.min(sample.height - 3, Math.floor(region.y + region.height));
  let total = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 5) {
    for (let x = left; x < right; x += 5) {
      const center = pixelLuma(sample, x, y);
      const horizontal = Math.abs(center - pixelLuma(sample, x + 3, y));
      const vertical = Math.abs(center - pixelLuma(sample, x, y + 3));
      total += Math.max(horizontal, vertical);
      count += 1;
    }
  }
  return count ? total / count : 0;
}

function walkRegion(sample: ImageSample, region: Region, visitor: (r: number, g: number, b: number) => void, step = 1) {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(sample.width, Math.floor(region.x + region.width));
  const bottom = Math.min(sample.height, Math.floor(region.y + region.height));
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const index = (y * sample.width + x) * sample.channels;
      visitor(sample.data[index], sample.data[index + 1], sample.data[index + 2]);
    }
  }
}

function estimateSharpness(data: Buffer, width: number, height: number, channels: number): number {
  let total = 0;
  let count = 0;
  for (let y = 2; y < height - 2; y += 4) {
    for (let x = 2; x < width - 2; x += 4) {
      const center = pixelLumaRaw(data, width, channels, x, y);
      total += Math.abs(center - pixelLumaRaw(data, width, channels, x + 2, y)) + Math.abs(center - pixelLumaRaw(data, width, channels, x, y + 2));
      count += 2;
    }
  }
  return roundOne(count ? total / count : 0);
}

function averageLuma(data: Buffer, channels: number): number {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += channels * 8) {
    sum += luma(data[index], data[index + 1], data[index + 2]);
    count += 1;
  }
  return count ? sum / count : 0;
}

function ratioWhere(data: Buffer, channels: number, predicate: (r: number, g: number, b: number) => boolean): number {
  let hits = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += channels * 6) {
    if (predicate(data[index], data[index + 1], data[index + 2])) hits += 1;
    count += 1;
  }
  return count ? hits / count : 0;
}

function pixelLuma(sample: ImageSample, x: number, y: number): number {
  const index = (y * sample.width + x) * sample.channels;
  return luma(sample.data[index], sample.data[index + 1], sample.data[index + 2]);
}

function pixelLumaRaw(data: Buffer, width: number, channels: number, x: number, y: number): number {
  const index = (y * width + x) * channels;
  return luma(data[index], data[index + 1], data[index + 2]);
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isWhitePixel(r: number, g: number, b: number, side: Side): boolean {
  const brightness = luma(r, g, b);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return side === 'back' ? brightness > 190 && spread < 54 : brightness > 222 && spread < 44;
}

function scoreCenteringSplit(split: number, side: Side): number {
  if (side === 'back') {
    if (split <= 55) return 10;
    if (split <= 60) return 9.5;
    if (split <= 65) return 9;
    if (split <= 70) return 8.5;
    if (split <= 75) return 8;
    if (split <= 82) return 7.5;
    return 7;
  }
  if (split <= 55) return 10;
  if (split <= 60) return 9;
  if (split <= 65) return 8.5;
  if (split <= 70) return 8;
  if (split <= 78) return 7.5;
  return 7;
}

function splitImbalance(a: number, b: number): number {
  const total = a + b;
  return total ? Math.max(a, b) / total * 100 : 50;
}

function ratioText(a: number, b: number): string {
  const total = a + b;
  if (!total) return '50/50';
  const first = Math.round(a / total * 100);
  return `${first}/${100 - first}`;
}

function combineScores(front: number, back: number | null): number {
  return back === null ? front : roundOne((front + back) / 2);
}

function sideRule(rule: CapRule, label: string): CapRule {
  return {
    maxGrade: rule.maxGrade,
    reason: `${label}: ${rule.reason}`
  };
}

function finalFormula(weighted: number, caps: CapRule[], finalGrade: number): string {
  const capText = caps.length ? `; caps applied: ${caps.map((rule) => rule.maxGrade).join(', ')}` : '; no cap rules applied';
  return `roundToNearestHalf(min(weighted ${roundOne(weighted)}, capRules)) = ${finalGrade}${capText}. Weights: centering 30%, corners 25%, edges 20%, surface 20%, whitening 5%.`;
}

function rectangleDebug(sample: ImageSample) {
  return {
    x: 0,
    y: 0,
    width: sample.width,
    height: sample.height,
    corners: [
      { x: 0, y: 0 },
      { x: sample.width, y: 0 },
      { x: sample.width, y: sample.height },
      { x: 0, y: sample.height }
    ]
  };
}

function pickCenteringDebug(center: CenteringAnalysis) {
  return {
    left: center.left,
    right: center.right,
    top: center.top,
    bottom: center.bottom,
    horizontalBalance: center.horizontalBalance,
    verticalBalance: center.verticalBalance
  };
}

function balance(a: number, b: number): number {
  const max = Math.max(a, b);
  return max ? Math.min(a, b) / max : 0;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values: number[]): number {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => Math.pow(value - mean, 2))));
}

function clampScore(value: number): number {
  return roundOne(Math.max(1, Math.min(10, value)));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

function labelForGrade(grade: number): string {
  if (grade >= 9.5) return 'Gem Mint candidate';
  if (grade >= 8.75) return 'Mint candidate';
  if (grade >= 7.75) return 'Near Mint-Mint estimate';
  if (grade >= 6.75) return 'Near Mint estimate';
  if (grade >= 5.75) return 'Excellent-Mint estimate';
  if (grade >= 4.75) return 'Excellent estimate';
  return 'Played/Damaged estimate';
}

function labelKey(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()).trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
