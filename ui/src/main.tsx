import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import { App } from './App';

// The shell's own window has no browser chrome; keep the page from acting like a web page.
window.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
});
window.addEventListener('dragover', (e) => e.preventDefault());

// While the window is being resized, animations and blur pause so every frame stays cheap.
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  document.documentElement.classList.add('is-resizing');
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => document.documentElement.classList.remove('is-resizing'), 220);
});
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
