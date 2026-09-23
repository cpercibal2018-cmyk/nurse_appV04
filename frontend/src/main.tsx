import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { queryClient } from './services/queryClient';
import './lib/i18n';
import './styles.css';

// No residency check here: the browser cannot know where the database lives.
// The server checks residency before it starts (backend/src/config/residency.ts).

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
