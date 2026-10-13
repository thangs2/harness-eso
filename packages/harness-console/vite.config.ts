import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.HARNESS_CONSOLE_URL ?? 'http://127.0.0.1:8791';

export default defineConfig({
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(root, 'src') } },
    server: {
        // 5191 — see harness-observatory/vite.config.ts: 5173–5175 belong to baplatform.
        port: Number(process.env.HARNESS_CONSOLE_DEV_PORT ?? 5191),
        proxy: { '/api': { target: API, changeOrigin: true }, '/health': { target: API } },
    },
    build: { outDir: 'dist', emptyOutDir: true },
});
