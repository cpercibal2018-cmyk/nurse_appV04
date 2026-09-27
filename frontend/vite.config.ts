import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from '../package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  // The product version (root package.json), shown at the foot of the sidebar.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5173,
    // Same-origin API in development: the refresh cookie is SameSite=Lax and
    // scoped to /api/v1/auth, so proxying avoids cross-site cookie handling.
    proxy: { '/api': 'http://localhost:3001' },
  },
  build: {
    target: 'es2022',
  },
});
