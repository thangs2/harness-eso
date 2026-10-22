/**
 * `harnessctl dsh bridge --out <dir>` — generate a DSH bundle that points the Claude-hook bridge at
 * the consumer's `.claude/settings.json`.
 *
 * The bundle contains no ESO code: it is the one row DSH needs, generated from a validated object so
 * the YAML cannot drift from what the probe/conformance commands expect.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    buildDshBridgePatch,
    buildDshBundleManifest,
    renderBundleReadme,
    renderCordisPatchYaml,
} from '../../harness-host-dsh/src/index.mjs';

export function writeDshBundle(dir, options = {}) {
    const target = path.resolve(dir);
    if (fs.existsSync(target) && fs.readdirSync(target).length && !options.force) {
        throw new Error(`${target} is not empty (use --force)`);
    }
    fs.mkdirSync(target, { recursive: true });

    const patch = buildDshBridgePatch({
        configPath: options.configPath,
        projectDir: options.projectDir,
        defaultTimeoutMs: options.timeoutMs,
    });
    const files = {
        'package.json': `${JSON.stringify(buildDshBundleManifest(options.name), null, 2)}\n`,
        'cordis.patch.yml': renderCordisPatchYaml(patch),
        'README.md': renderBundleReadme({ configPath: patch.rows[0].config.configPath }),
    };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(target, name), content);
    return { dir: target, files: Object.keys(files), patch };
}

export function runDshBridge(argv = []) {
    const opts = { out: null, configPath: undefined, projectDir: undefined, timeoutMs: undefined, force: false, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--out') opts.out = argv[++i];
        else if (a === '--config-path') opts.configPath = argv[++i];
        else if (a === '--project-dir') opts.projectDir = argv[++i];
        else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]);
        else if (a === '--force') opts.force = true;
        else if (a === '--json') opts.json = true;
        else throw new Error(`unknown flag: ${a}`);
    }
    if (!opts.out) throw new Error('usage: harnessctl dsh bridge --out <dir> [--config-path ./.claude/settings.json] [--project-dir .] [--timeout 120000] [--force]');

    const result = writeDshBundle(opts.out, opts);
    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return result;
    }
    console.log(`\nbundle written: ${result.dir}`);
    for (const file of result.files) console.log(`  ${file}`);
    console.log('\nInstall it in DSH: Plugins -> install a bundle, target = this directory.');
    console.log('UNSAFE on the desktop app (0.2.1-rc.2): the bridge needs peerDependencies that duplicate');
    console.log('app-shipped packages, which splits Symbol identity and kills every tool call (ATF-OPS-001).');
    console.log('Check first: harnessctl doctor dsh --profile desktop');
    console.log('Prerequisite: the consumer has .claude/settings.json —');
    console.log('  already provisioned: harnessctl host-pack add-ide --profile claude-superset <consumer>');
    console.log('  fresh consumer:      harnessctl init profile <consumer> --host-mode claude\n');
    return result;
}
