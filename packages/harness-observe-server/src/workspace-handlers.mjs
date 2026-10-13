import {
    configureAdd,
    configureList,
    configureUse,
    productStateDir,
} from '@mu/harness-foundation/workspace';

export function workspaceConfigured() {
    return Boolean(productStateDir());
}

export async function handleWorkspaceRequest(pathname, req) {
    if (!workspaceConfigured()) {
        return new Response(
            JSON.stringify({
                ok: false,
                error: 'product_state_unconfigured',
                hint: 'Set HARNESS_PRODUCT_STATE_DIR (Docker: mount harness-eso/.harness)',
            }),
            { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } },
        );
    }

    if (pathname === '/api/workspace' && req.method === 'GET') {
        return json(configureList());
    }

    if (pathname === '/api/workspace/projects' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.root) {
            return json({ ok: false, error: 'root required' }, 400);
        }
        try {
            return json(
                configureAdd({
                    consumerPath: body.root,
                    projectId: body.id,
                    displayName: body.displayName || body.name,
                    port: body.port,
                    profile: body.profile,
                }),
            );
        } catch (err) {
            return json({ ok: false, error: err.message || String(err) }, 400);
        }
    }

    if (pathname === '/api/workspace/use' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.id) return json({ ok: false, error: 'id required' }, 400);
        try {
            return json(configureUse(body.id));
        } catch (err) {
            return json({ ok: false, error: err.message || String(err) }, 400);
        }
    }

    return null;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}

async function readJson(req) {
    try {
        return await req.json();
    } catch {
        return {};
    }
}
