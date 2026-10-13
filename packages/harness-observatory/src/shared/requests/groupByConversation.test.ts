import { describe, expect, it } from 'vitest';
import { groupRequestsByConversation } from './groupByConversation';
import type { RequestListItem } from '@/shared/api/types';

function row(partial: Partial<RequestListItem> & { id: string; conversationId: string }): RequestListItem {
    return {
        boundaryIndex: 0,
        userQuery: 'q',
        status: 'done',
        ...partial,
    };
}

describe('groupRequestsByConversation', () => {
    it('groups and sorts by latest startedAt', () => {
        const items = [
            row({ id: 'a', conversationId: 'c1', startedAt: '2026-01-02T00:00:00Z', boundaryIndex: 2 }),
            row({ id: 'b', conversationId: 'c1', startedAt: '2026-01-01T00:00:00Z', boundaryIndex: 1 }),
            row({ id: 'c', conversationId: 'c2', startedAt: '2026-01-03T00:00:00Z', boundaryIndex: 1 }),
        ];
        const groups = groupRequestsByConversation(items);
        expect(groups).toHaveLength(2);
        expect(groups[0].conversationId).toBe('c2');
        expect(groups[1].items.map((i) => i.id)).toEqual(['a', 'b']);
    });
});
