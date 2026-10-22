import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainNodeCard } from './BrainNodeCard';
import type { BrainNode } from '@/shared/api/types';

function node(overrides: Partial<BrainNode> = {}): BrainNode {
    return {
        id: 'note:/w/packages/App.tsx',
        kind: 'note',
        layer: 'memory',
        label: 'App.tsx',
        area: 'packages',
        path: '/w/packages/App.tsx',
        pathHost: '/w/packages/App.tsx',
        previewable: true,
        note: '3 request(s)',
        changed: '2026-10-01T10:00:00Z',
        degree: 4,
        weight: 3,
        ...overrides,
    };
}

function renderCard(n: BrainNode) {
    return render(
        <MemoryRouter>
            <BrainNodeCard node={n} onClose={() => {}} onFlyTo={() => {}} />
        </MemoryRouter>,
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('BrainNodeCard', () => {
    it('offers the guarded file preview only for a node that has a path', () => {
        const { unmount } = renderCard(node());
        expect(screen.getByRole('button', { name: 'Open file' })).toBeTruthy();
        unmount();

        renderCard(node({ kind: 'run', id: 'run:c:1', path: null, label: 'a turn' }));
        expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Open request' }).getAttribute('href')).toBe('/requests/c%3A1');
    });

    it('does not offer "Open file" for a node the server cannot read', () => {
        renderCard(node({ previewable: false }));
        expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy();
        expect(screen.getByText(/not readable from the server/)).toBeTruthy();
    });

    it('renders the preview and says when the read was truncated', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    path: '/real/w/packages/App.tsx',
                    relativePath: 'packages/App.tsx',
                    bytes: 2048,
                    shownBytes: 100,
                    truncated: true,
                    text: 'export function App() {}',
                }),
            })),
        );
        renderCard(node());
        fireEvent.click(screen.getByRole('button', { name: 'Open file' }));

        await waitFor(() => expect(screen.getByText('export function App() {}')).toBeTruthy());
        expect(screen.getByText(/showing 100 of 2048 bytes/)).toBeTruthy();
        expect(screen.getByText(/truncated at the preview cap/)).toBeTruthy();
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
            '/api/brain/file?node=note%3A%2Fw%2Fpackages%2FApp.tsx',
        );
    });

    it('surfaces the server refusal instead of an empty preview', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 403,
                json: async () => ({ error: 'outside_root', message: 'path resolves outside the project root' }),
            })),
        );
        renderCard(node());
        fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('path resolves outside the project root'));
    });

    it('shows "no timestamp" rather than an invented date', () => {
        renderCard(node({ changed: null }));
        expect(screen.getByText('no timestamp recorded')).toBeTruthy();
    });
});
