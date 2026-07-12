import React from 'react';

function canShowErrorDetails() {
  if (import.meta.env.DEV || import.meta.env.VITE_SHOW_DEPLOY_DIAGNOSTICS === 'true') return true;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('debug');
}

export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[hit-grading:render-error]', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="page-shell">
        <section className="app-error-panel">
          <h1>The app failed to render.</h1>
          <p>Check browser console or deployment config. The page is still alive, but React hit a runtime error.</p>
          {canShowErrorDetails() ? <pre>{this.state.error.message || String(this.state.error)}</pre> : null}
          <p>
            For Vercel frontend-only testing, enable <code>VITE_USE_MOCK_SCAN=true</code> and
            <code> VITE_SHOW_DEPLOY_DIAGNOSTICS=true</code>, then redeploy.
          </p>
        </section>
      </main>
    );
  }
}
