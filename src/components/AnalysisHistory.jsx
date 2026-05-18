import { History } from 'lucide-react';

export function AnalysisHistory({ items }) {
  return (
    <section className="history-section">
      <div className="history-heading">
        <History size={16} />
        <h2>Card Analysis History</h2>
      </div>

      {items.length === 0 ? (
        <div className="history-empty">Analyzed cards will appear here after grading.</div>
      ) : (
        <div className="history-list">
          {items.map((item) => (
            <article className="history-item" key={item.id}>
              <div className="history-thumbs">
                {item.previews.front ? <img src={item.previews.front} alt="Analyzed card front" /> : <div>Front</div>}
                {item.previews.back ? <img src={item.previews.back} alt="Analyzed card back" /> : <div>Back</div>}
              </div>
              <div className="history-copy">
                <div className="history-title">
                  <strong>{item.frontName}</strong>
                  <span>{item.createdAt}</span>
                </div>
                <div className="history-stats">
                  <span>Grade {item.grade.toFixed(1)}</span>
                  <span>{item.conditionLabel}</span>
                  <span>{item.confidence}% confidence</span>
                </div>
                <p>{item.marketValueRange}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
