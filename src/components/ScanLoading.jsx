const scanSteps = [
  'Analyzing card...',
  'Reading card text...',
  'Checking collector number...',
  'Matching card identity...'
];

export function ScanLoading() {
  return (
    <div className="scan-loading" role="status" aria-live="polite">
      <div className="scan-card-outline" aria-hidden="true">
        <span className="scan-sweep" />
      </div>
      <div className="scan-copy">
        <strong>Analyzing card</strong>
        <div className="scan-step-list">
          {scanSteps.map((step, index) => (
            <span key={step} style={{ '--step-index': index }}>
              {step}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
