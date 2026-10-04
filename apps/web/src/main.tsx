import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './app';
import { createQueryClient } from './query-client';
import { initTheme } from './theme';
import './styles.css';

// Before the first paint, so an operator who chose light does not see a dark
// frame first. The attribute is always written, including for `system`, which
// is what lets the stylesheet define each token exactly once per theme.
initTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

const queryClient = createQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
