export function ScoreBar({ label, value }) {
  return (
    <div className="score-row">
      <div className="score-copy">
        <span>{label}</span>
        <strong>{value.toFixed(1)}</strong>
      </div>
      <div className="score-track">
        <div className="score-fill" style={{ width: `${Math.max(0, Math.min(value, 10)) * 10}%` }} />
      </div>
    </div>
  );
}
