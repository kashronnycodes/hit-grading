import { useEffect, useState } from 'react';
import { RotateCcw, Search, Sparkles } from 'lucide-react';
import { IdentificationDebugPanel } from './IdentificationDebugPanel.jsx';

function getIdentityBanner(status) {
  switch (status) {
    case 'identified':
      return { title: 'Card identified', copy: 'The card identity is confirmed.' };
    case 'needs_better_photo':
      return { title: 'Retake photo recommended', copy: 'The collector number area could not be read clearly.' };
    case 'needs_confirmation':
      return { title: 'Please confirm the card', copy: 'A likely match was found, but it needs user confirmation.' };
    case 'manual_review':
      return { title: 'Manual review needed', copy: 'Review the possible matches before confirming.' };
    case 'no_match':
      return { title: 'No reliable match found', copy: 'Try a clearer photo or correct the result manually.' };
    default:
      return { title: 'Review result', copy: 'Review the scan result before continuing.' };
  }
}

export function Results({ result, files, previews, onReset, onConfirm, onShowAlternatives, onPickAlternative, showAlternatives, onStartManualCrop, onCorrectResult, correcting }) {
  const closestMatch = result.closestMatch;
  const detected = result.detectedDetails || {};
  const rawOfficial = result.officialMatch || closestMatch || {};
  const confirmedIdentity = Boolean(result.confirmedIdentity);
  const userConfirmed = Boolean(result.userConfirmed);
  const identityStatus = result.identityStatus || result.identity?.status || (confirmedIdentity ? 'identified' : 'manual_review');
  const pricingEligible = Boolean(result.pricingEligible);
  const bestGuess = rawOfficial?.id ? rawOfficial : (result.possibleMatches?.[0] || result.alternatives?.[0] || {});
  const official = confirmedIdentity ? rawOfficial : {};
  const selectedLanguage = result.debug?.identification?.selectedLanguage;
  const alternatives = result.alternatives?.length ? result.alternatives : (result.possibleMatches || []);
  const stateBanner = getIdentityBanner(identityStatus);
  const [correction, setCorrection] = useState({
    cardName: detected.cardName || rawOfficial.cardName || bestGuess.cardName || '',
    cardNumber: detected.cardNumber || rawOfficial.cardNumber || bestGuess.cardNumber || '',
    setCode: detected.setCode || rawOfficial.setCode || bestGuess.setCode || '',
    language: detected.language || rawOfficial.language || bestGuess.language || selectedLanguage || 'English'
  });
  const [showDebugDetails, setShowDebugDetails] = useState(false);
  const debugEnabled = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');

  useEffect(() => {
    setCorrection({
      cardName: detected.cardName || rawOfficial.cardName || bestGuess.cardName || '',
      cardNumber: detected.cardNumber || rawOfficial.cardNumber || bestGuess.cardNumber || '',
      setCode: detected.setCode || rawOfficial.setCode || bestGuess.setCode || '',
      language: detected.language || rawOfficial.language || bestGuess.language || selectedLanguage || 'English'
    });
  }, [result.scanId, detected.cardName, detected.cardNumber, detected.setCode, detected.language, rawOfficial.cardName, rawOfficial.cardNumber, rawOfficial.setCode, rawOfficial.language, bestGuess.cardName, bestGuess.cardNumber, bestGuess.setCode, bestGuess.language, selectedLanguage]);

  const display = {
    heading: userConfirmed
      ? 'User confirmed'
      : !confirmedIdentity && bestGuess.cardName
        ? 'Best guess'
        : official.confidenceLabel === 'Fallback match found'
      ? 'Fallback match found'
      : official.confidenceLabel === 'Strong match found' || official.confidenceLabel === 'Strong match'
      ? 'Strong match found'
      : official.cardName || detected.cardName
        ? 'Review needed'
        : 'No strong match found yet',
    cardName: official.cardName || (!confirmedIdentity ? bestGuess.cardName : '') || detected.cardName || 'Unavailable',
    cardNumber: official.cardNumber || (!confirmedIdentity ? bestGuess.cardNumber : '') || detected.cardNumber || 'Unavailable',
    language: official.language || (!confirmedIdentity ? bestGuess.language : '') || detected.language || selectedLanguage || 'Unknown',
    setSeries: official.setSeries || official.setOrSeries || (!confirmedIdentity ? (bestGuess.setSeries || bestGuess.setOrSeries) : '') || detected.setSeries || detected.setOrSeries || detected.setCode || 'Unavailable',
    rarity: official.rarity || (!confirmedIdentity ? bestGuess.rarity : '') || detected.rarity || 'Unavailable',
    estimatedValue: pricingEligible ? (result.estimatedValue || official.estimatedValue || closestMatch?.estimatedValue || null) : null
  };
  const quality = result.quality;
  const evidence = result.matchEvidence || {};
  const condition = result.conditionEstimate;
  const confirmCandidate = rawOfficial.id ? rawOfficial : bestGuess;
  const possibleSource = !confirmedIdentity && bestGuess.id ? 'Possible match / needs confirmation' : '';
  const sourceLabel = (officialValue, detectedValue, fallbackLabel = 'Detected from image') => {
    if (userConfirmed && officialValue) return 'User confirmed';
    if (!confirmedIdentity && officialValue) return 'Possible match / needs confirmation';
    if (official.source === 'local_fallback_database' && officialValue) return 'From fallback database / needs review';
    if (official.source && official.source !== 'ocr_fallback' && officialValue) return 'Confirmed by database';
    if (official.source === 'ocr_fallback' && officialValue) return 'Review needed';
    if (detectedValue) return fallbackLabel;
    return '';
  };
  const setSourceLabel = userConfirmed && (official.setSeries || official.setOrSeries)
    ? 'User confirmed'
    : !confirmedIdentity && (bestGuess.setSeries || bestGuess.setOrSeries)
    ? 'Possible match / needs confirmation'
    : official.source === 'local_fallback_database' && (official.setSeries || official.setOrSeries)
    ? 'From fallback database / needs review'
    : official.source && official.source !== 'ocr_fallback' && (official.setSeries || official.setOrSeries)
    ? 'Confirmed by database'
    : detected.setSeries
      ? `Inferred from ${detected.setCode || 'detected set code'}`
      : detected.setCode
        ? `Inferred from ${detected.setCode}`
        : '';
  const updateCorrection = (field, value) => setCorrection((current) => ({ ...current, [field]: value }));
  const rerunSearch = () => onCorrectResult?.(correction);
  const conditionCategories = condition?.breakdown ? [
    ['Centering', condition.breakdown.centering],
    ['Corners', condition.breakdown.corners],
    ['Edges', condition.breakdown.edges],
    ['Surface', condition.breakdown.surface],
    ['Whitening', condition.breakdown.whitening],
    ['Print Quality', condition.breakdown.printQuality]
  ] : [];

  return (
    <section className="results-card">
      <div className="results-topline">
        <Sparkles size={20} />
        <span>{result.status === 'partial' ? 'Partial Detection Report' : 'Card Detection Report'}</span>
      </div>

      <div className={`identity-banner ${identityStatus}`}>
        <strong>{stateBanner.title}</strong>
        <span>{result.reason || result.identity?.reason || stateBanner.copy}</span>
        {userConfirmed ? <em>User confirmed</em> : null}
      </div>

      {!confirmedIdentity ? (
        <div className="confirmation-guidance">
          <strong>{result.needsBetterPhoto ? 'Retake photo recommended' : 'Manual confirmation needed'}</strong>
          <span>
            {result.needsBetterPhoto
              ? 'The card was detected, but the collector number area looks blurry or glared. Please retake the photo closer, sharper, and with less reflection.'
              : 'This result is a possible match only. Confirm the correct card below before using pricing or official metadata.'}
          </span>
        </div>
      ) : null}

      {result.message ? (
        <div className={`result-banner ${result.status || 'success'}`}>
          {result.message}
        </div>
      ) : null}

      <div className="result-previews">
        {['front', 'back'].map((side) => (
          <div className="result-preview" key={side}>
            {side === 'front'
              ? (closestMatch?.imageUrl || result.normalizedImageUrl || result.rawImageUrl || previews.front
                  ? <img src={closestMatch?.imageUrl || result.normalizedImageUrl || result.rawImageUrl || previews.front} alt={`${side} card`} />
                  : <div className="result-no-preview">{files[side]?.name || 'Front image unavailable'}</div>)
              : (previews[side]
                  ? <img src={previews[side]} alt={`${side} card`} />
                  : <div className="result-no-preview">{files[side]?.name || 'Back image optional'}</div>)}
            <span>{side === 'front' ? 'Front' : 'Back'}</span>
          </div>
        ))}
      </div>

      <section className="info-section scan-quality-section">
        <div className="section-heading">
          <p>Scan Quality</p>
          <strong>{quality ? `${quality.score}/100` : 'Not scored'}</strong>
          <span>{quality?.recommendation || 'Scan completed'}</span>
        </div>
        {quality?.warnings?.length ? (
          <ul className="compact-list">
            {quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        ) : <p className="section-copy">Image quality looks usable for identification.</p>}
      </section>

      <div className="notes-panel">
        <h3>Detected Card Details</h3>
        <ul>
          <li>Card Name: {detected.cardName || 'Not found'}</li>
          <li>Card Number: {detected.cardNumber || 'Not found'}</li>
          <li>Language: {detected.language || 'Unknown'}</li>
          <li>Set/Series: {detected.setOrSeries || detected.setSeries || detected.setCode || 'Not found'}</li>
          <li>HP: {detected.hp || 'Not found'}</li>
          <li>Rarity: {detected.rarity || 'Unknown'}</li>
          <li>Year: {detected.year || 'Not found'}</li>
        </ul>
      </div>

      <div className="grade-panel result-detail-grid">
        <div className="result-grid-heading">
          <p>{confirmedIdentity ? 'Confirmed Card Identity' : 'Possible Match Found'}</p>
          <strong>{display.heading}</strong>
        </div>
        <div>
          <p>{confirmedIdentity ? 'Card Name' : 'Best Guess Name'}</p>
          <strong>{display.cardName}</strong>
          {possibleSource || sourceLabel(official.cardName, detected.cardName) ? <span className="value-source">{possibleSource || sourceLabel(official.cardName, detected.cardName)}</span> : null}
        </div>
        <div>
          <p>{confirmedIdentity ? 'Card Number' : 'Best Guess Number'}</p>
          <strong>{display.cardNumber}</strong>
          {possibleSource || sourceLabel(official.cardNumber, detected.cardNumber) ? <span className="value-source">{possibleSource || sourceLabel(official.cardNumber, detected.cardNumber)}</span> : null}
        </div>
        <div>
          <p>{confirmedIdentity ? 'Language' : 'Detected Language'}</p>
          <strong>{display.language}</strong>
          <span className="value-source">{official.language ? sourceLabel(official.language, detected.language, 'Selected language') : detected.language || selectedLanguage ? 'Selected language' : ''}</span>
        </div>
        <div>
          <p>{confirmedIdentity ? 'Set/Series' : 'Possible Set/Series'}</p>
          <strong>{display.setSeries}</strong>
          {setSourceLabel ? <span className="value-source">{setSourceLabel}</span> : null}
        </div>
        <div>
          <p>{confirmedIdentity ? 'Rarity' : 'Possible Rarity'}</p>
          <strong>{display.rarity}</strong>
          {possibleSource || sourceLabel(official.rarity, detected.rarity) ? <span className="value-source">{possibleSource || sourceLabel(official.rarity, detected.rarity)}</span> : null}
        </div>
        <div>
          <p>Estimated Value</p>
          <strong>
            {!pricingEligible
              ? 'Pricing available after card confirmation'
              : display.estimatedValue
              ? (display.estimatedValue.label || `${display.estimatedValue.currency || 'USD'} ${display.estimatedValue.amount || display.estimatedValue.market || display.estimatedValue.mid || display.estimatedValue.high || display.estimatedValue.low || 'N/A'}`)
              : 'Pricing not available yet.'}
          </strong>
          {!pricingEligible
            ? <span className="value-source">Confirm the card before pricing.</span>
            : display.estimatedValue?.source
              ? <span className="value-source">{display.estimatedValue.source === 'fallback_manual_market_estimate' ? 'Estimated only' : `Confirmed by ${display.estimatedValue.source}`}</span>
              : <span className="value-source">No pricing provider returned a value.</span>}
        </div>
      </div>

      <section className="info-section">
        <div className="section-heading">
          <p>Why We Matched This</p>
          <strong>{evidence.matchedCardLabel || `${display.cardName} - ${display.cardNumber}`}</strong>
          <span>Confidence: {typeof evidence.confidenceScore === 'number' ? `${Math.round(evidence.confidenceScore * 100)}%` : 'Needs review'}</span>
        </div>
        <div className="evidence-list">
          <div className={evidence.nameMatched ? 'matched' : 'review'}><span>{evidence.nameMatched ? 'Matched' : 'Review'}</span>Name: {detected.cardName || display.cardName}</div>
          <div className={evidence.numberMatched ? 'matched' : 'review'}><span>{evidence.numberMatched ? 'Matched' : 'Review'}</span>Number: {detected.cardNumber || 'Not detected'}</div>
          <div className={evidence.setMatched ? 'matched' : 'review'}><span>{evidence.setMatched ? 'Matched' : 'Review'}</span>Set: {detected.setCode || display.setSeries}</div>
          <div><span>Source</span>{official.source || 'OCR fallback'}</div>
        </div>
        {evidence.uncertainFields?.length || evidence.missingFields?.length ? (
          <p className="section-copy">
            Uncertain: {[...(evidence.uncertainFields || []), ...(evidence.missingFields || [])].slice(0, 5).join(', ')}
          </p>
        ) : null}
      </section>

      <section className="info-section correction-section">
        <div className="section-heading">
          <p>Correct This Result</p>
          <strong>Manual correction</strong>
          <span>Re-run search without uploading again</span>
        </div>
        <div className="correction-grid">
          <label>
            <span>Card name</span>
            <input value={correction.cardName} onChange={(event) => updateCorrection('cardName', event.target.value)} />
          </label>
          <label>
            <span>Collector number</span>
            <input value={correction.cardNumber} onChange={(event) => updateCorrection('cardNumber', event.target.value)} />
          </label>
          <label>
            <span>Set code</span>
            <input value={correction.setCode} onChange={(event) => updateCorrection('setCode', event.target.value)} />
          </label>
          <label>
            <span>Language</span>
            <input value={correction.language} onChange={(event) => updateCorrection('language', event.target.value)} />
          </label>
        </div>
        <button className="secondary-action correction-action" disabled={correcting} onClick={rerunSearch}>
          <Search size={18} /> {correcting ? 'Re-running Search...' : 'Re-run Search'}
        </button>
      </section>

      <section className="info-section condition-estimate-section">
        <div className="section-heading">
          <p>AI Condition Estimate</p>
          <strong>{condition?.gradeAvailable ? `${condition.estimatedGrade}/10` : 'Condition estimate unavailable'}</strong>
          <span>{condition?.gradeAvailable ? `${condition.gradeLabel} | ${condition.confidence} confidence | ${condition.mode?.replace(/_/g, ' ')}` : condition?.message || 'Back image needed for full condition estimate.'}</span>
        </div>
        <p className="section-copy">{condition?.disclaimer || 'AI-estimated raw condition grade, not an official PSA/BGS/CGC grade.'}</p>
        {condition?.summary ? <p className="section-copy">{condition.summary}</p> : null}
        {condition?.gradeAvailable ? (
          <div className="condition-meta-list">
            <div><span>Condition Score</span><strong>{condition.conditionScore ?? condition.estimatedGrade}/10</strong></div>
            <div><span>Photo Quality</span><strong>{condition.photoQualityScore ?? 'N/A'}/100</strong></div>
            <div><span>Grading Confidence</span><strong>{condition.gradingConfidence || condition.confidence}</strong></div>
          </div>
        ) : null}
        {condition?.confidence === 'low' && condition.gradeAvailable ? <p className="section-copy">Low-confidence estimate. Retake with sharper front/back photos for better accuracy.</p> : null}
        {!previews.back ? <p className="section-copy">Upload back image for better estimate.</p> : null}
        {condition?.warnings?.length ? (
          <ul className="compact-list">
            {condition.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        ) : null}
        {condition?.capRulesApplied?.length ? (
          <div className="condition-subsection">
            <h3>Cap Rules Applied</h3>
            <ul>
              {condition.capRulesApplied.map((rule) => <li key={rule}>{rule}</li>)}
            </ul>
          </div>
        ) : null}
        {condition?.retakeTips?.length ? (
          <div className="condition-subsection">
            <h3>Retake Tips</h3>
            <ul>
              {condition.retakeTips.slice(0, 5).map((tip) => <li key={tip}>{tip}</li>)}
            </ul>
          </div>
        ) : null}
        {condition?.gradeAvailable ? (
          <div className="condition-breakdown-grid">
            {conditionCategories.map(([label, category]) => (
              <article className="condition-score-card" key={label}>
                <div>
                  <span>{label}</span>
                  <strong>{category.score === null || category.score === undefined ? 'N/A' : `${category.score}/10`}</strong>
                </div>
                <small>
                  {category.frontScore !== undefined && category.frontScore !== null ? `Front ${category.frontScore}` : ''}
                  {category.frontScore !== undefined && category.frontScore !== null && category.backScore !== undefined && category.backScore !== null ? ' | ' : ''}
                  {category.backScore !== undefined && category.backScore !== null ? `Back ${category.backScore}` : ''}
                </small>
                {category.notes?.length ? (
                  <ul>
                    {category.notes.slice(0, 3).map((note) => <li key={note}>{note}</li>)}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>

      {result.detectionNotes?.length || result.warnings?.length ? (
        <div className="notes-panel">
          <h3>Detection Notes</h3>
          <ul>
            {(result.detectionNotes || result.warnings || []).map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      ) : null}

      <h3 className="confirmation-title">Is this the correct card?</h3>
      <div className="result-actions">
        {confirmCandidate?.id && !confirmedIdentity ? (
          <button className="secondary-action confirm-action" onClick={() => onConfirm(confirmCandidate)}>
            Confirm this card
          </button>
        ) : confirmedIdentity ? (
          <span className="confirmed-pill">{userConfirmed ? 'User confirmed' : 'Confirmed by detection'}</span>
        ) : null}
        {confirmCandidate?.id && confirmedIdentity && !userConfirmed ? (
          <button className="secondary-action confirm-action" onClick={() => onConfirm(confirmCandidate)}>
            Yes, this is correct
          </button>
        ) : null}
        {(result.manualSearchSuggested || result.status === 'needs_manual_crop') && result.rawImageUrl ? (
          <button className="secondary-action ghost-action" onClick={onStartManualCrop}>
            Crop card manually
          </button>
        ) : null}
        <button className="secondary-action ghost-action" onClick={onShowAlternatives}>
          {showAlternatives ? 'Hide matches' : 'No, choose another match'}
        </button>
      </div>

      {showAlternatives ? (
        <div className="alternatives-panel">
          {alternatives.length ? alternatives.map((candidate) => (
            <div className="alternative-item" key={`${candidate.source}-${candidate.id}`}>
              <button className="alternative-main" onClick={() => onPickAlternative(candidate)}>
                <span>{candidate.cardName}</span>
                <strong>
                  {candidate.game}
                  {candidate.setOrSeries ? ` | ${candidate.setOrSeries}` : ''}
                  {candidate.cardNumber ? ` | ${candidate.cardNumber}` : ''}
                </strong>
              </button>
              <button className="alternative-confirm" onClick={() => onConfirm(candidate)}>
                Confirm this card
              </button>
            </div>
          )) : <p className="empty-alternatives">No alternative matches were strong enough to return yet.</p>}
        </div>
      ) : null}

      {debugEnabled ? (
        <>
          <button className="secondary-action ghost-action" onClick={() => setShowDebugDetails((current) => !current)}>
            {showDebugDetails ? 'Hide Debug Details' : 'Show Debug Details'}
          </button>
          {showDebugDetails ? <IdentificationDebugPanel result={result} previews={previews} /> : null}
        </>
      ) : null}

      <button className="secondary-action" onClick={onReset}>
        <RotateCcw size={19} /> Grade Another Card
      </button>
    </section>
  );
}
