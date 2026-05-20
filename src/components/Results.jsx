import { RotateCcw, Sparkles } from 'lucide-react';
import { IdentificationDebugPanel } from './IdentificationDebugPanel.jsx';

export function Results({ result, files, previews, onReset, onConfirm, onShowAlternatives, onPickAlternative, showAlternatives, onStartManualCrop }) {
  const closestMatch = result.closestMatch;
  const hasMatch = Boolean(closestMatch);
  const detected = result.detectedDetails || {};
  const alternatives = result.alternatives?.length ? result.alternatives : (result.possibleMatches || []);
  const debugEnabled = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');

  return (
    <section className="results-card">
      <div className="results-topline">
        <Sparkles size={20} />
        <span>{result.status === 'partial' ? 'Partial Detection Report' : 'Card Detection Report'}</span>
      </div>

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

      <div className="notes-panel">
        <h3>Detected Card Details</h3>
        <ul>
          <li>Card Name: {detected.cardName || 'Not found'}</li>
          <li>Card Number: {detected.cardNumber || 'Not found'}</li>
          <li>Language: {detected.language || 'Unknown'}</li>
          <li>Set/Series: {detected.setOrSeries || detected.setSeries || detected.setCode || 'Not found'}</li>
          <li>Rarity: {detected.rarity || 'Unknown'}</li>
        </ul>
      </div>

      <div className="grade-panel result-detail-grid">
        <div className="result-grid-heading">
          <p>Closest Match Found</p>
          <strong>{hasMatch ? 'Official card record' : 'No strong match found yet'}</strong>
        </div>
        <div>
          <p>Official Card Name</p>
          <strong>{closestMatch?.cardName || 'Review needed'}</strong>
        </div>
        <div>
          <p>Official Card Number</p>
          <strong>{closestMatch?.cardNumber || 'Unavailable'}</strong>
        </div>
        <div>
          <p>Official Language</p>
          <strong>{closestMatch?.language || 'Unknown'}</strong>
        </div>
        <div>
          <p>Official Set/Series</p>
          <strong>{closestMatch?.setOrSeries || 'Unavailable'}</strong>
        </div>
        <div>
          <p>Official Rarity</p>
          <strong>{closestMatch?.rarity || 'Unavailable'}</strong>
        </div>
        <div>
          <p>Estimated Value</p>
          <strong>
            {closestMatch?.estimatedValue
              ? `${closestMatch.estimatedValue.currency || 'USD'} ${closestMatch.estimatedValue.market || closestMatch.estimatedValue.mid || closestMatch.estimatedValue.high || closestMatch.estimatedValue.low || 'N/A'}`
              : 'Unavailable'}
          </strong>
        </div>
      </div>

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
        {hasMatch ? (
          <button className="secondary-action confirm-action" onClick={() => onConfirm(closestMatch)}>
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
            <button className="alternative-item" key={`${candidate.source}-${candidate.id}`} onClick={() => onPickAlternative(candidate)}>
              <span>{candidate.cardName}</span>
              <strong>
                {candidate.game}
                {candidate.setOrSeries ? ` | ${candidate.setOrSeries}` : ''}
                {candidate.cardNumber ? ` | ${candidate.cardNumber}` : ''}
              </strong>
            </button>
          )) : <p className="empty-alternatives">No alternative matches were strong enough to return yet.</p>}
        </div>
      ) : null}

      {debugEnabled ? <IdentificationDebugPanel result={result} previews={previews} /> : null}

      <button className="secondary-action" onClick={onReset}>
        <RotateCcw size={19} /> Grade Another Card
      </button>
    </section>
  );
}
