import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const API_TARGET = process.env.HARNESS_OBSERVE_URL ?? 'http://127.0.0.1:8792';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: { '@': path.resolve(root, 'src') },
    },
    server: {
        host: '127.0.0.1',
        /*
         * 5190, not Vite's default 5173. Ports 5173–5175 belong to the baplatform dev stack; two
         * Vite servers fighting over the same default means whichever starts second silently
         * shifts to 5174/5175 and the URL in the runbook is then wrong. Keep the whole product on
         * one explicit, out-of-the-way block.
         */
        port: Number(process.env.HARNESS_OBSERVATORY_DEV_PORT ?? 5190),
        proxy: {
            '/api': { target: API_TARGET, changeOrigin: true },
            '/events': { target: API_TARGET, changeOrigin: true },
            '/health': { target: API_TARGET, changeOrigin: true },
        },
    },
    test: {
        environment: 'jsdom',
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
