import { RotateCcw, Sparkles } from 'lucide-react';
import { ScoreBar } from './ScoreBar.jsx';

export function Results({ result, files, previews, onReset }) {
  return (
    <section className="results-card">
      <div className="results-topline">
        <Sparkles size={20} />
        <span>AI Condition Report</span>
      </div>

      <div className="result-previews">
        {['front', 'back'].map((side) => (
          <div className="result-preview" key={side}>
            {previews[side] ? <img src={previews[side]} alt={`${side} card`} /> : <div className="result-no-preview">{files[side].name}</div>}
            <span>{side === 'front' ? 'Front' : 'Back'}</span>
          </div>
        ))}
      </div>

      <div className="grade-panel">
        <div>
          <p>Final Grade</p>
          <strong>{result.grade.toFixed(1)}</strong>
        </div>
        <div>
          <p>Condition</p>
          <strong>{result.conditionLabel}</strong>
        </div>
        <div>
          <p>Confidence</p>
          <strong>{result.confidence}%</strong>
        </div>
      </div>

      <div className="breakdown">
        <ScoreBar label="Centering" value={result.breakdown.centering} />
        <ScoreBar label="Corners" value={result.breakdown.corners} />
        <ScoreBar label="Edges" value={result.breakdown.edges} />
        <ScoreBar label="Surface" value={result.breakdown.surface} />
      </div>

      <div className="notes-panel">
        <h3>AI Notes</h3>
        <ul>
          {result.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      </div>

      <div className="market-panel">
        <span>Estimated Market Value Range</span>
        <strong>{result.marketValueRange}</strong>
      </div>

      <button className="secondary-action" onClick={onReset}>
        <RotateCcw size={19} /> Grade Another Card
      </button>
    </section>
  );
}
