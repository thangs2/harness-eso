import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
};

/**
 * SPA static files from `@mu/harness-observatory` build (`dist/`).
 * Unknown paths fall back to `index.html` for client-side routes.
 */
export function createStaticHandler(staticRoot) {
    if (!staticRoot || !fs.existsSync(staticRoot)) {
        return () => null;
    }
    const root = path.resolve(staticRoot);

    return function serveStatic(pathname) {
        /*
         * A path under an API prefix is never a client route, so it must resolve to a real file or
         * not at all.
         *
         * This has to be decided BEFORE the SPA rewrite below, and that ordering is the whole point:
         * an unknown dotless path maps straight to `index.html` (that is how client-side routing
         * works, and `/requests/<id>` depends on it). So a check placed after the rewrite never runs
         * for `/v1/whatever` — it has already resolved to the SPA shell.
         *
         * Without this, a request to a removed or misspelled versioned route answered `200` with
         * `text/html`: an API client saw success and HTML, and a removal could not be observed from
         * the outside. That is exactly how the deleted `/v1/guard/write` (F27) still looked alive.
         */
        const isApiPrefix =
            pathname.startsWith('/api') || pathname.startsWith('/events') || pathname.startsWith('/v1');
        if (isApiPrefix) {
            const apiFile = path.resolve(root, pathname.replace(/^\/+/, ''));
            if (!apiFile.startsWith(root)) return null;
            if (!fs.existsSync(apiFile) || !fs.statSync(apiFile).isFile()) return null;
        }

        const rel =
            pathname === '/' || !pathname.includes('.')
                ? 'index.html'
                : pathname.replace(/^\/+/, '');
        const full = path.resolve(root, rel);
        if (!full.startsWith(root)) return null;

        let file = full;
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            file = path.join(root, 'index.html');
        }
        if (!fs.existsSync(file)) return null;

        const body = fs.readFileSync(file);
        return new Response(body, {
            headers: {
                'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                'cache-control': 'no-store',
            },
        });
    };
}

/** Resolve observatory dist next to monorepo packages. */
export function defaultObservatoryDist() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '../../harness-observatory/dist');
}
