import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// `npm run dev:web` proxies the API to a Bohemarr running on the default port.
export default defineConfig({
  root: import.meta.dirname,
  base: '/ui/',
  plugins: [preact()],
  server: { proxy: { '/v1': 'http://127.0.0.1:8787' } },
});
