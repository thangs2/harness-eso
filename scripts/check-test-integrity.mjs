#!/usr/bin/env node
/**
 * Hash-protect the Stage 7 RED packets. The verifier writes them; the builder must not change them.
 *
 * Law: sdlc/02/governance/01.standard/09.build-enforcement.md (E2).
 *
 * Why the RED packet and not the acceptance test code: Stage 7 is the *spec* that names the exact
 * test file, the exact test name and the concrete expected failure. The test code itself arrives at
 * Stage 8 and is expected to change on the way to GREEN — hashing it (`test_hash`) pinned a file that
 * does not exist yet (the RTM records 0/37 created) and froze a target that must move. The RED packet
 * is the immutable half, so that is what the pack pins.
 *
 * Usage:
 *   node scripts/check-test-integrity.mjs ESO-401
 *   node scripts/check-test-integrity.mjs ESO-401 --write    # prints the hash for `red_packet_hash`
 *
 * `--write` only prints; it never edits the pack.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const PACK_DIR = 'sdlc/09.wbs/00.jira/packs';

/** Stage 7 output lives here and nowhere else: a RED packet outside this tree is not a RED packet. */
export const RED_PACKET_DIR = 'sdlc/10.test';

export function packPath(ticket) {
    if (!/^ESO-\d+$/.test(String(ticket || ''))) throw new Error(`invalid ticket id: ${ticket}`);
    return resolve(PACK_DIR, `${ticket}.json`);
}

export function readPack(ticket) {
    const path = packPath(ticket);
    if (!existsSync(path)) throw new Error(`ticket pack not found: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8'));
}

/** Read a pack from an arbitrary path, so the gate can be exercised on a fixture (no commit). */
export function readPackFile(file) {
    const path = resolve(file);
    if (!existsSync(path)) throw new Error(`ticket pack not found: ${path}`);
    const pack = JSON.parse(readFileSync(path, 'utf8'));
    return { pack, path };
}

/**
 * Resolve one `red_packets[]` entry to a real file under `sdlc/10.test/`.
 * Accepts the object form (`{ packet }`) and the bare string form, so the failure message can say
 * which one the pack used instead of throwing on a shape it did not expect.
 */
export function resolveRedPacket(entry, root = process.cwd()) {
    const rel = typeof entry === 'string' ? entry : entry?.packet;
    if (!rel || typeof rel !== 'string') return { ok: false, reason: 'RED_PACKET_NO_PATH' };
    const normalised = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalised.includes('..')) return { ok: false, reason: `RED_PACKET_OUTSIDE_TEST_DIR:${rel}` };
    if (!normalised.startsWith(`${RED_PACKET_DIR}/`)) {
        return { ok: false, reason: `RED_PACKET_OUTSIDE_TEST_DIR:${rel}` };
    }
    if (!normalised.endsWith('.md')) return { ok: false, reason: `RED_PACKET_NOT_MARKDOWN:${rel}` };
    const absolute = resolve(root, normalised);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        return { ok: false, reason: `MISSING_RED_PACKET:${rel}` };
    }
    return { ok: true, rel: normalised, absolute };
}

/**
 * Deterministic hash over the sorted relative path + content of every RED packet the pack names.
 * Sorted and de-duplicated so two packs listing the same packets in a different order agree.
 */
export function hashRedPackets(packets, root = process.cwd()) {
    const list = Array.isArray(packets) ? packets : [];
    const rels = [];
    for (const entry of list) {
        const resolved = resolveRedPacket(entry, root);
        if (!resolved.ok) return { ok: false, reason: resolved.reason, hash: null, files: [] };
        rels.push(resolved.rel);
    }
    if (rels.length === 0) return { ok: false, reason: 'NO_RED_PACKET', hash: null, files: [] };

    const files = [...new Set(rels)].sort();
    const hash = createHash('sha256');
    for (const rel of files) {
        hash.update(rel);
        hash.update('\0');
        hash.update(readFileSync(resolve(root, rel)));
        hash.update('\0');
    }
    return { ok: true, reason: null, hash: `sha256:${hash.digest('hex')}`, files };
}

/**
 * Compare the pack's `red_packet_hash` pin against the packets on disk.
 * A pack with no pin is allowed (not every ticket is handed out with one); a pin that says
 * `pending` is not — that is the old `test_hash` placeholder wearing a new name.
 */
export function verifyRedPacketIntegrity(pack, root = process.cwd()) {
    const result = hashRedPackets(pack?.red_packets, root);
    if (!result.ok) return { ...result, pinned: false };
    const pin = pack?.red_packet_hash;
    if (pin === undefined || pin === null || pin === '') return { ...result, ok: true, pinned: false };
    if (String(pin).includes('pending')) {
        return { ...result, ok: false, reason: 'RED_PACKET_HASH_NOT_SET', pinned: true };
    }
    if (pin !== result.hash) {
        return {
            ...result,
            ok: false,
            reason: `RED_PACKET_HASH_MISMATCH expected=${pin} actual=${result.hash}`,
            pinned: true,
        };
    }
    return { ...result, ok: true, pinned: true };
}

function main() {
    const [ticket, flag] = process.argv.slice(2);
    if (!ticket) {
        console.error('usage: node scripts/check-test-integrity.mjs <ESO-nnn> [--write]');
        process.exit(2);
    }
    try {
        const pack = readPack(ticket);
        const result = hashRedPackets(pack.red_packets);
        if (!result.ok) {
            console.error(result.reason);
            process.exit(1);
        }
        if (flag === '--write') {
            console.log(result.hash);
            process.exit(0);
        }
        const verdict = verifyRedPacketIntegrity(pack);
        console.log(JSON.stringify({ ticket, ...verdict }, null, 2));
        process.exit(verdict.ok ? 0 : 1);
    } catch (error) {
        console.error(error.message);
        process.exit(2);
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) main();
