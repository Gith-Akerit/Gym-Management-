import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `APP_REVISION` is baked in at build time and travels with every problem
// report. Half of any report arrives after the next deploy, and without it
// nobody can tell which version of the screen the person was describing.
// Empty when nobody passed one, which is honest: unknown, not wrong.
export default defineConfig({
  plugins: [react()],
  define: { __APP_REVISION__: JSON.stringify(process.env.APP_REVISION ?? '') },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
