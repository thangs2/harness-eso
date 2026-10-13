/**
 * Shell guard — `beforeShellExecution` / `shell.before`.
 *
 * Static denies first (no config needed), then the decision facade for policy-driven
 * verdicts. Runs from the host pack via the dispatcher; it must not require the
 * harness-eso checkout, Docker, or the observe plane to be available.
 */
import { decide } from '@mu/harness-decision';
import {
    allow,
    deny,
    detectShape,
    extractShellCommand,
    loadPolicyForCwd,
    readStdin,
} from './hook-io.mjs';

const LOCAL_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    'mongo',
    'mongodb',
    'redis',
    'host.docker.internal',
]);
const URL_RE = /(?:mongodb(?:\+srv)?|postgres|postgresql|mysql|redis):\/\/[^\s'"]+/gi;
const HOST_KV_RE = /(?:Host|Server)=([^;\s'"]+)/gi;
const FLAG_HOST_RE = /(?:-h|--host)(?:=|\s+)(\S+)/gi;
const DROP_DB_RE = /\bdrop\s+database\b|\bdropdb\b|dropdatabase\s*\(/i;
const SECRET_REDIRECT_RE =
    /(?:>>?|\btee\b)\s+\S*(?:\.env(?:\.\w+)?|credentials\.json|id_rsa|id_ed25519|\.pem|\.pfx)\b/i;

function hostOfUrl(url) {
    let rest = url.split('://')[1] || url;
    rest = rest.split('/', 1)[0];
    if (rest.includes('@')) rest = rest.split('@', 1)[1];
    rest = rest.split(':', 1)[0];
    return rest.replace(/^\[|\]$/g, '').toLowerCase();
}

function remoteHosts(command) {
    const found = [];
    for (const match of command.matchAll(URL_RE)) found.push(hostOfUrl(match[0]));
    for (const match of command.matchAll(HOST_KV_RE)) found.push(match[1].trim().toLowerCase());
    for (const match of command.matchAll(FLAG_HOST_RE)) {
        found.push(match[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase());
    }
    return found.filter((h) => h && !LOCAL_HOSTS.has(h));
}

function staticDenyReason(command) {
    if (DROP_DB_RE.test(command)) return 'Database guard: DROP DATABASE is blocked.';
    if (SECRET_REDIRECT_RE.test(command)) return 'Secret-file write via shell is blocked.';
    const lowered = command.toLowerCase();
    const hosts = remoteHosts(command);
    const dbClient = ['mongosh', 'mongo ', 'redis-cli', 'psql', 'mysql', 'sqlcmd'].some((t) =>
        lowered.includes(t),
    );
    if (hosts.length && dbClient) {
        return `Data-store command targets a non-local host (${hosts.join(', ')}). Local hosts only.`;
    }
    return null;
}

export async function run() {
    let data = {};
    let shape = 'cursor';
    try {
        const raw = await readStdin();
        data = raw.trim() ? JSON.parse(raw) : {};
        shape = detectShape(data);
    } catch {
        allow(shape);
        return;
    }

    const command = extractShellCommand(data);
    if (!command) {
        allow(shape);
        return;
    }

    const staticReason = staticDenyReason(command);
    if (staticReason) {
        deny(shape, staticReason);
        return;
    }

    const { policy } = loadPolicyForCwd();
    const requestId =
        data.generation_id ??
        data.generationId ??
        data.conversation_id ??
        data.conversationId ??
        `shell-${Date.now()}`;

    try {
        const resolved = await decide(
            {
                event: 'pre_guard_shell',
                turnId: requestId,
                shellCommand: command,
            },
            { policy, writeLedger: false },
        );
        const verdict = resolved.guard?.verdict || 'allow';
        if (verdict === 'deny') {
            deny(shape, `Shell guard: ${resolved.resolverWinner || 'denied'}.`);
            return;
        }
        if (verdict === 'ask' && policy.jev?.mode === 'active') {
            deny(shape, 'Shell guard: confirmation required (Jev active).');
            return;
        }
        allow(shape, { shellGuard: resolved.resolverWinner || 'allow' });
    } catch (err) {
        if (policy.jev?.mode === 'active') {
            deny(shape, 'Shell guard: unexpected error (fail-closed).');
            return;
        }
        allow(shape, { shellGuardError: String(err?.message || err) });
    }
}
