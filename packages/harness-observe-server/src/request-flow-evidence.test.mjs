import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichRequestEvents, loadAttachedForRequest, relPath } from './request-flow-evidence.mjs';

describe('request-flow-evidence', () => {
    it('relPath strips consumer root', () => {
        assert.equal(relPath('/proj', '/proj/foo/bar.mdc'), 'foo/bar.mdc');
    });

    it('enrichRequestEvents fills path from raw_json', () => {
        const rows = enrichRequestEvents(
            [
                {
                    harness: 'cursor',
                    eventType: 'postToolUse',
                    tool: 'Read',
                    path: '',
                    hookAt: '2026-01-01T00:00:00Z',
                    command: null,
                    raw_json: JSON.stringify({
                        path: '/proj/src/a.ts',
                        payload: { tool_input: { path: '/proj/src/a.ts' } },
                    }),
                },
            ],
            '/proj',
        );
        assert.equal(rows[0].path, 'src/a.ts');
    });

    it('loadAttachedForRequest unions generation attachments', () => {
        const db = {
            all(sql, params) {
                if (sql.includes('json_each') && sql.includes('generation_id')) {
                    return [{ type: 'rule', filePath: 'core.agent-pipeline.mdc' }];
                }
                if (sql.includes('request_rule')) return [];
                if (sql.includes('hook_prompt')) return null;
                if (sql.includes('request_id = ?') && sql.includes('attachments')) return [];
                return [];
            },
            get() {
                return null;
            },
        };
        const attached = loadAttachedForRequest(db, 'p1', {
            id: 'c:1',
            generation_id: 'gen-1',
            conversation_id: 'c',
            started_at: '2026-01-01T00:00:00Z',
        });
        assert.equal(attached.length, 1);
        assert.equal(attached[0].filePath, 'core.agent-pipeline.mdc');
    });
});
