import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initializeAppearance } from './lib/appearance';
import { initializeTheme } from './lib/theme';
import './theme.css';
import './styles.css';

initializeTheme();
initializeAppearance();

const root = document.getElementById('root');

if (!root) {
  throw new Error('Application root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
