import { History } from 'lucide-react';

export function AnalysisHistory({ items, loading }) {
  return (
    <section className="history-section">
      <div className="history-heading">
        <History size={16} />
        <h2>Card Analysis History</h2>
      </div>

      {items.length === 0 ? (
        <div className="history-empty">{loading ? 'Loading saved scans...' : 'Detected cards will appear here after scanning.'}</div>
      ) : (
        <div className="history-list">
          {items.map((item) => (
            <article className="history-item" key={item.scanId || item.id}>
              <div className="history-thumbs">
                {item.normalizedImageUrl || item.previews?.front ? <img src={item.normalizedImageUrl || item.previews.front} alt="Analyzed card front" /> : <div>Front</div>}
                {item.rawImageUrl || item.previews?.back ? <img src={item.rawImageUrl || item.previews.back} alt="Analyzed card back" /> : <div>Back</div>}
              </div>
              <div className="history-copy">
                <div className="history-title">
                  <strong>{item.closestMatch?.cardName || item.detectedDetails?.cardName || 'Unconfirmed card'}</strong>
                  <span>{item.createdAt ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(item.createdAt)) : 'Just now'}</span>
                </div>
                <div className="history-stats">
                  <span>{item.closestMatch?.game || item.detectedGame || 'Unknown game'}</span>
                  <span>{item.closestMatch?.setOrSeries || item.detectedDetails?.setOrSeries || 'No set/series'}</span>
                  <span>{item.closestMatch?.rarity || item.detectedDetails?.rarity || 'Unknown rarity'}</span>
                </div>
                <p>
                  {item.closestMatch?.estimatedValue
                    ? `${item.closestMatch.estimatedValue.currency || 'USD'} ${item.closestMatch.estimatedValue.market || item.closestMatch.estimatedValue.mid || item.closestMatch.estimatedValue.high || item.closestMatch.estimatedValue.low || 'N/A'}`
                    : 'No pricing yet'}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
