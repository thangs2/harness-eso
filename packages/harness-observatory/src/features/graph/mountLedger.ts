/**
 * Ownership ledger for graphs mounted into a set of hosts.
 *
 * The blueprint grid mounts and tears down several canvases from one effect. Getting that right
 * under React 18 StrictMode — which runs mount → cleanup → mount on purpose — is what this exists
 * for. The previous design kept a single `mountedKeyRef` string and reset it from a *separate*
 * `[]`-deps teardown effect, and that was enough to leak:
 *
 *   1. effect runs, claims the key, starts `await import('@antv/g6')`
 *   2. StrictMode's simulated unmount fires the teardown cleanup, which clears the key
 *   3. effect runs again, sees the key unclaimed, and mounts a SECOND graph into every host
 *
 * Both graphs stayed alive and each appended its own canvases — eight per panel, at identical
 * zoom and positions. Because they overlapped exactly the duplicate was invisible until a drag:
 * the top canvas moved the node while the copy underneath stayed put. That reads as a node being
 * cloned.
 *
 * The ledger makes the invariant explicit: a run owns a token, cleanup invalidates it, and work
 * that finishes after its token was invalidated is destroyed instead of published. Deriving the
 * token here rather than inside the component is what makes it testable without a canvas.
 */
export type Destroyable = { destroy: () => void };

export class MountLedger<T extends Destroyable> {
    private token = 0;
    private entries: Array<{ token: number; value: T }> = [];

    /** Start a run. Anything owned by an earlier run is destroyed first. */
    begin(): number {
        this.token += 1;
        this.destroyAll();
        return this.token;
    }

    get currentToken(): number {
        return this.token;
    }

    isStale(token: number): boolean {
        return token !== this.token;
    }

    /**
     * Publish a value for `token`.
     *
     * Returns `false` — and destroys the value — when the token has been superseded, which is the
     * case that used to leave a duplicate graph alive.
     */
    keep(token: number, value: T): boolean {
        if (this.isStale(token)) {
            safeDestroy(value);
            return false;
        }
        this.entries.push({ token, value });
        return true;
    }

    /** Invalidate the current run and destroy everything it owned. Called from effect cleanup. */
    invalidate(): void {
        this.token += 1;
        this.destroyAll();
    }

    destroyAll(): void {
        for (const entry of this.entries) safeDestroy(entry.value);
        this.entries = [];
    }

    /** Number of live, current-run values. */
    get size(): number {
        return this.entries.length;
    }
}

function safeDestroy(value: Destroyable | null | undefined): void {
    try {
        value?.destroy();
    } catch {
        /* a failed destroy must not abort teardown of the remaining canvases */
    }
}
