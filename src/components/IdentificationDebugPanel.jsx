function formatValue(value, fallback = 'Not detected') {
  return value || fallback;
}

function formatConfidence(value) {
  if (typeof value !== 'number') return '0%';
  return `${Math.round(value * 100)}%`;
}

export function IdentificationDebugPanel({ result, previews }) {
  const debug = result.debug?.identification;
  const apiDebug = result.debug?.api;
  const regionImages = result.debug?.ocr?.regionImages;
  const uploadedImageUrl = debug?.uploadedImageUrl || result.rawImageUrl || previews.front;
  const normalizedImageUrl = debug?.normalizedImageUrl || result.normalizedImageUrl;
  const extracted = debug?.extractedFields || {};
  const topMatches = debug?.topMatches || [];
  const queries = debug?.queriesUsed || result.debug?.queriesUsed || [];

  return (
    <section className="debug-panel">
      <div className="debug-heading">
        <span>Development Identification Debug</span>
        <strong>Pokemon OCR/Search Pipeline</strong>
      </div>

      <div className="debug-image-grid">
        <div className="debug-image-card">
          <span>Uploaded image preview</span>
          {uploadedImageUrl ? <img src={uploadedImageUrl} alt="Uploaded card debug preview" /> : <div>No uploaded preview</div>}
        </div>
        <div className="debug-image-card">
          <span>Normalized card image</span>
          {normalizedImageUrl ? <img src={normalizedImageUrl} alt="Normalized card debug preview" /> : <div>No normalized preview</div>}
        </div>
      </div>

      <div className="debug-grid">
        <div>
          <span>Selected game</span>
          <strong>{formatValue(debug?.selectedGame, 'None')}</strong>
        </div>
        <div>
          <span>Selected language</span>
          <strong>{formatValue(debug?.selectedLanguage, 'Auto-detect')}</strong>
        </div>
      </div>

      <details className="debug-details" open>
        <summary>OCR Text</summary>
        <div className="debug-text-block">
          <span>Raw OCR text</span>
          <pre>{debug?.rawOcrText || 'No raw OCR text returned.'}</pre>
        </div>
        <div className="debug-text-block">
          <span>Cleaned OCR text</span>
          <pre>{debug?.cleanedOcrText || result.debug?.ocrDigest || 'No cleaned OCR text returned.'}</pre>
        </div>
      </details>

      <div className="debug-field-list">
        <h3>Extracted Fields</h3>
        <dl>
          <div><dt>Card name</dt><dd>{formatValue(extracted.name)}</dd></div>
          <div><dt>Collector/card number</dt><dd>{formatValue(extracted.cardNumber)}</dd></div>
          <div><dt>Set name or set code</dt><dd>{formatValue(extracted.setCode)}</dd></div>
          <div><dt>HP / stats</dt><dd>{formatValue(extracted.hp)}</dd></div>
          <div><dt>Attack damage</dt><dd>{formatValue(extracted.damage)}</dd></div>
          <div><dt>Copyright year</dt><dd>{formatValue(extracted.year)}</dd></div>
          <div><dt>Detected language</dt><dd>{formatValue(extracted.language)}</dd></div>
          <div><dt>Rarity</dt><dd>{formatValue(extracted.rarity)}</dd></div>
          <div><dt>Text clue</dt><dd>{formatValue(extracted.attackNameHint)}</dd></div>
        </dl>
      </div>

      <div className="debug-field-list">
        <h3>Search Queries Used</h3>
        {queries.length ? (
          <ol className="debug-query-list">
            {queries.map((query, index) => <li key={`${query}-${index}`}>{query}</li>)}
          </ol>
        ) : (
          <p>No search queries were executed.</p>
        )}
      </div>

      {apiDebug?.calls?.length ? (
        <details className="debug-details">
          <summary>API Calls</summary>
          <div className="debug-call-list">
            {apiDebug.calls.map((call, index) => (
              <div className="debug-call" key={`${call.source}-${call.searchType}-${index}`}>
                <strong>{call.source} / {call.searchType}</strong>
                <span>{call.endpoint}</span>
                <small>
                  query: {call.query || 'n/a'} | status: {call.status || 'error'} | matches: {call.resultCount ?? 0}
                  {call.topMatchName ? ` | top: ${call.topMatchName}` : ''}
                  {call.error ? ` | error: ${call.error}` : ''}
                </small>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="debug-field-list">
        <h3>Top 5 Matched Card Results</h3>
        <div className="debug-match-list">
          {topMatches.length ? topMatches.slice(0, 5).map((match) => (
            <article className="debug-match" key={`${match.source}-${match.id}`}>
              {match.imageUrl ? <img src={match.imageUrl} alt={`${match.cardName} official card`} /> : <div className="debug-match-placeholder" />}
              <div>
                <div className="debug-match-title">
                  <strong>{match.cardName}</strong>
                  <span>{formatConfidence(match.confidence)}</span>
                </div>
                <p>
                  {match.source}
                  {match.cardNumber ? ` | #${match.cardNumber}` : ''}
                  {match.setOrSeries ? ` | ${match.setOrSeries}` : ''}
                  {match.rarity ? ` | ${match.rarity}` : ''}
                </p>
                {match.confidenceReasons?.length ? (
                  <ul>
                    {match.confidenceReasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                ) : <small>No score reasons returned.</small>}
              </div>
            </article>
          )) : <p>No card matches were returned.</p>}
        </div>
      </div>

      {regionImages ? (
        <div className="debug-field-list">
          <h3>OCR Region Crops</h3>
          <div className="debug-image-grid">
            {Object.entries(regionImages).map(([label, imageUrl]) => (
              imageUrl ? (
                <div className="debug-image-card" key={label}>
                  <span>{label}</span>
                  <img src={imageUrl} alt={`${label} OCR crop`} />
                </div>
              ) : null
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
