#!/usr/bin/env bun
/**
 * Docgraph MCP for harness-eso window — queries law/spec via global `docgraph` CLI.
 * Default repo: $DOCGRAPH_REPO (x79 sibling). Install: `bun install` in `.cursor/mcp/`.
 */
import { spawnSync } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_REPO = process.env.DOCGRAPH_REPO || '';
const DEFAULT_HARNESS = process.env.DOCGRAPH_HARNESS || 'cursor';
const DOCGRAPH_BIN = process.env.DOCGRAPH_BIN || 'docgraph';

function runDocgraph(query, top, repo) {
    const q = String(query || '').trim();
    if (!q) return { content: [{ type: 'text', text: '' }] };

    const args = ['--q', q, '--top', String(top ?? 10), '--harness', DEFAULT_HARNESS];
    const root = String(repo || DEFAULT_REPO || '').trim();
    if (root) args.push('--repo', root);

    const r = spawnSync(DOCGRAPH_BIN, args, {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...(root ? { DOCGRAPH_REPO: root } : {}) },
    });

    if (r.error) {
        return {
            content: [{ type: 'text', text: `docgraph error: ${r.error.message}` }],
            isError: true,
        };
    }
    const err = r.stderr?.trim();
    const out = r.stdout?.trim() || '';
    if (r.status !== 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: [err, out].filter(Boolean).join('\n') || `docgraph exit ${r.status}`,
                },
            ],
            isError: true,
        };
    }
    const header = root ? `# docgraph repo=${root}\n` : '# docgraph\n';
    return { content: [{ type: 'text', text: header + (out || '(no matches)') }] };
}

const server = new Server(
    { name: 'docgraph-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'docgraph_query',
            description:
                'Search x79 law/spec markdown index (document/harness, sdlc, .cursor/rules). Same as CLI docgraph --q. Use for ESO contracts, observe API, harness-tooling.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Space-separated OR terms' },
                    top: { type: 'number', description: 'Max pointers (default 10)' },
                    repo: {
                        type: 'string',
                        description: 'Optional repo root override (default DOCGRAPH_REPO, usually x79)',
                    },
                },
                required: ['query'],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'docgraph_query') {
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    const { query, top, repo } = req.params.arguments ?? {};
    return runDocgraph(query, top, repo);
});

const transport = new StdioServerTransport();
await server.connect(transport);
