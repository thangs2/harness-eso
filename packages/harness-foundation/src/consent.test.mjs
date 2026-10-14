import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    consentCovers,
    consentDir,
    consentFile,
    grantConsent,
    liveConsents,
    readConsentStore,
    revokeConsent,
} from './consent.mjs';

/**
 * Consent is the human half of the `ask` tier. Its whole value is that the record lives somewhere the
 * agent's gates do not reach and is written by something other than the agent, so most of these tests are
 * about that separation rather than about JSON handling.
 */

/** Point product state at a temp dir, so a test never touches the operator's real consent records. */
function withState(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-consent-'));
    const prev = process.env.HARNESS_PRODUCT_STATE_DIR;
    process.env.HARNESS_PRODUCT_STATE_DIR = root;
    try {
        return fn(root);
    } finally {
        if (prev === undefined) delete process.env.HARNESS_PRODUCT_STATE_DIR;
        else process.env.HARNESS_PRODUCT_STATE_DIR = prev;
    }
}

test('consent lives in product state, not in the repo', () => {
    /*
     * The load-bearing decision. `.cursor/session/` must stay agent-writable — the Brain stamp and the
     * preflight bundle are written there by the agent's own hooks — so a consent file beside them would
     * be forgeable, and one was: a real incident had the agent write an ESO stamp claiming `allowWrite:
     * true` and a `hilWaiver` string, both of which it produced itself.
     */
    withState((root) => {
        assert.equal(consentDir(), path.join(root, 'consent'));
        assert.equal(consentFile('x79'), path.join(root, 'consent', 'x79.json'));
        // And explicitly not under any repo's session dir, which is the place that has to stay
        // agent-writable and therefore cannot hold a trust anchor.
        assert.doesNotMatch(consentDir(), /session/);
    });
});

test('an absent store is no consent, never consent', () => {
    withState(() => {
        assert.deepEqual(readConsentStore('p').records, []);
        assert.equal(consentCovers('p', 'sdlc/08.wbs/x.md').ok, false);
    });
});

test('a granted record covers its subtree, and a sibling it does not', () => {
    withState(() => {
        grantConsent('p', { path: 'sdlc/08.wbs/' });
        assert.equal(consentCovers('p', 'sdlc/08.wbs/03.stories/x/02.qc.md').ok, true);
        assert.equal(consentCovers('p', 'sdlc/08.wbs').ok, true, 'the bare directory too');
        assert.equal(consentCovers('p', 'sdlc/00.governance/x.md').ok, false, 'a sibling is not covered');
        assert.equal(consentCovers('p', 'sdlc/08.wbs-other/x.md').ok, false, 'and neither is a prefix collision');
    });
});

test('an exact file grant does not cover its siblings', () => {
    withState(() => {
        grantConsent('p', { path: 'sdlc/08.wbs/00.index.md' });
        assert.equal(consentCovers('p', 'sdlc/08.wbs/00.index.md').ok, true);
        assert.equal(consentCovers('p', 'sdlc/08.wbs/01.other.md').ok, false);
    });
});

test('an expired record is not an approval', () => {
    withState(() => {
        grantConsent('p', { path: 'sdlc/x.md', ttlSeconds: 1 });
        assert.equal(consentCovers('p', 'sdlc/x.md').ok, true, 'live now');
        const later = new Date(Date.now() + 5000);
        assert.equal(consentCovers('p', 'sdlc/x.md', later).ok, false, 'and gone after its ttl');
        assert.deepEqual(liveConsents('p', later), []);
    });
});

test('a record with an unparseable expiry is not an approval', () => {
    // A missing or malformed timestamp must fail closed. Treating it as "no expiry" would make a
    // hand-edited file an unlimited grant.
    withState(() => {
        const file = consentFile('p');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            JSON.stringify({ version: 1, records: [{ id: 'x', path: 'sdlc/x.md', at: '2026-01-01T00:00:00Z' }] }),
        );
        assert.equal(consentCovers('p', 'sdlc/x.md').ok, false);
    });
});

test('re-approving a path replaces rather than accumulates', () => {
    // One live answer per path, so "what is currently approved" is a single lookup and the file stays
    // readable instead of growing a history nobody prunes.
    withState(() => {
        grantConsent('p', { path: 'sdlc/x.md' });
        grantConsent('p', { path: 'sdlc/x.md' });
        assert.equal(readConsentStore('p').records.length, 1);
        assert.equal(liveConsents('p').length, 1);
    });
});

test('revoke removes by path and by id, and reports what it removed', () => {
    withState(() => {
        const a = grantConsent('p', { path: 'sdlc/a.md' });
        grantConsent('p', { path: 'sdlc/b.md' });
        assert.equal(revokeConsent('p', { path: 'sdlc/a.md' }).removed, 1);
        assert.equal(consentCovers('p', 'sdlc/a.md').ok, false);
        assert.equal(consentCovers('p', 'sdlc/b.md').ok, true, 'the other grant survives');
        assert.equal(revokeConsent('p', { id: a.id }).removed, 0, 'already removed by path');
        assert.equal(revokeConsent('p', { path: 'nope' }).removed, 0);
    });
});

test('the record names its approver, so an out-of-band grant is distinguishable', () => {
    /*
     * Not a signature — an agent with shell access runs as the same user, so there is no key it cannot
     * read, and pretending otherwise would be theatre. What the field buys is attribution: a grant that
     * did not come from the console can be told apart from one that did.
     */
    withState(() => {
        const r = grantConsent('p', { path: 'sdlc/x.md' });
        assert.equal(r.approvedBy, 'human:console');
        assert.ok(r.id);
        assert.ok(Date.parse(r.at));
        assert.ok(Date.parse(r.expiresAt) > Date.parse(r.at));
        assert.equal(grantConsent('p', { path: 'sdlc/y.md', approvedBy: 'human:cli' }).approvedBy, 'human:cli');
    });
});

test('grants are scoped per project', () => {
    withState(() => {
        grantConsent('alpha', { path: 'sdlc/x.md' });
        assert.equal(consentCovers('alpha', 'sdlc/x.md').ok, true);
        assert.equal(consentCovers('beta', 'sdlc/x.md').ok, false, 'a grant is not global');
    });
});

test('a grant without a path is refused rather than stored as unrestricted', () => {
    // An empty path would match nothing, but it would also sit in the file looking like an approval.
    withState(() => {
        assert.throws(() => grantConsent('p', { path: '' }), /needs a path/);
        assert.throws(() => grantConsent('p', {}), /needs a path/);
    });
});

test('overlapping grants resolve to the newest, and any covering grant is enough', () => {
    withState(() => {
        grantConsent('p', { path: 'sdlc/08.wbs/' });
        grantConsent('p', { path: 'sdlc/' });
        assert.equal(consentCovers('p', 'sdlc/08.wbs/x.md').ok, true);
        assert.equal(consentCovers('p', 'sdlc/03.analysis/x.md').ok, true, 'the broader grant covers it');
        assert.equal(liveConsents('p')[0].path, 'sdlc/', 'newest first');
    });
});
