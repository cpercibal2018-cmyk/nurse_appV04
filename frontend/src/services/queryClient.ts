import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './http';

// Shared by the provider and the session store: protected server data must be
// cleared on every sign-out or change of identity/privileges, not only when the
// user clicks the logout button in the application shell.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Retry only transient failures; a 4xx answer will not change on retry.
      retry: (count, e) => count < 2 && !(e instanceof ApiError && e.status >= 400 && e.status < 500),
    },
  },
});
