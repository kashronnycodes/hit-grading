import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { AppErrorBoundary } from './components/AppErrorBoundary.jsx';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  document.body.innerHTML = '<main class="page-shell"><section class="app-error-panel"><h1>The app failed to render.</h1><p>Root element was not found in index.html.</p></section></main>';
} else {
  try {
    createRoot(rootElement).render(
      <React.StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    console.error('[hit-grading:mount-error]', error);
    rootElement.innerHTML = '<main class="page-shell"><section class="app-error-panel"><h1>The app failed to render.</h1><p>React could not mount. Check browser console or deployment config.</p></section></main>';
  }
}
