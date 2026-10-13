import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: { '@': path.resolve(root, 'src') },
    },
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
        // @testing-library/react registers its auto-cleanup on the global `afterEach`, so
        // without this the DOM from one test leaks into the next and queries fail with
        // "Found multiple elements".
        globals: true,
    },
});
