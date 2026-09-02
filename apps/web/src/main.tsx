import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

/**
 * `mutations.retry` is set, and that is what makes the idempotency key mean
 * something.
 *
 * The default is 0, so before this a failed write was never retried, and the
 * client's `newIdempotencyKey` docblock — which says a retry carries the key
 * its first attempt used — described protection nothing could reach. Setting
 * it makes the sentence true rather than rewording it, and the key is what
 * makes the retry safe: react-query hands the same `variables` back, so the
 * second attempt is recognised as the same command rather than a second one.
 *
 * One retry, with a short delay. A write that fails twice is a write the person
 * should be told about, not one to keep trying at.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 1, retryDelay: 500 },
  },
});

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
