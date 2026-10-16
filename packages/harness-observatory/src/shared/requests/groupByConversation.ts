import type { RequestListItem } from '@/shared/api/types';

export interface ConversationGroup {
    conversationId: string;
    ide: string;
    items: RequestListItem[];
    latestStartedAt: string | null;
}

export function groupRequestsByConversation(items: RequestListItem[]): ConversationGroup[] {
    const map = new Map<string, RequestListItem[]>();
    for (const row of items) {
        const key = row.conversationId || '(no conversation)';
        const bucket = map.get(key);
        if (bucket) bucket.push(row);
        else map.set(key, [row]);
    }
    const groups: ConversationGroup[] = [];
    for (const [conversationId, rows] of map) {
        const sorted = [...rows].sort((a, b) => {
            const ta = a.startedAt || '';
            const tb = b.startedAt || '';
            return tb.localeCompare(ta) || (b.boundaryIndex ?? 0) - (a.boundaryIndex ?? 0);
        });
        const detectedIde = sorted.find((r) => r.ide && r.ide !== 'unknown')?.ide || sorted[0]?.ide || 'unknown';
        groups.push({
            conversationId,
            ide: detectedIde,
            items: sorted,
            latestStartedAt: sorted[0]?.startedAt ?? null,
        });
    }
    groups.sort((a, b) => (b.latestStartedAt || '').localeCompare(a.latestStartedAt || ''));
    return groups;
}
