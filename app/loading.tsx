/**
 * v19.3: shown the moment a tab, a week arrow or a seat is tapped, while the server answers —
 * so a tap never looks like nothing happened. The real page replaces it as soon as it is ready.
 */
export default function Loading() {
  return (
    <main className="page" aria-busy="true">
      <span className="sr-only" role="status">Loading…</span>
      <div className="topbar" aria-hidden="true">
        <div className="stack" style={{ gap: 8 }}>
          <i className="skel" style={{ width: 160, height: 26 }} />
          <i className="skel" style={{ width: 110, height: 12 }} />
        </div>
        <div className="nav">
          {[56, 72, 54, 62].map((w, k) => <i key={k} className="skel skel-pill" style={{ width: w }} />)}
        </div>
      </div>
      <div className="stack" aria-hidden="true">
        <i className="skel" style={{ height: 50, borderRadius: 14 }} />
        {[92, 92, 92, 92, 92].map((h, k) => <i key={k} className="skel" style={{ height: h, borderRadius: 14 }} />)}
      </div>
    </main>
  );
}
