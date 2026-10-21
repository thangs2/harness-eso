#!/usr/bin/env node
import { loadConfig } from '@mu/harness-observe-server';
import { applyWorkspaceEnv } from './workspace-env.mjs';
import { runObservatory } from './observatory-cmd.mjs';
import { runConsole } from './console-cmd.mjs';
import { configureListCli, configureUseCli } from './project-init.mjs';
import { runInitProfile } from './init-profile-cmd.mjs';
import { runHostPack } from './host-pack-cmd.mjs';
import { runStorageGc, storageStatus } from './storage-gc.mjs';
import { runTokenDiet } from './token-diet-cmd.mjs';
import { runVerifyConsumer } from './verify-consumer-cmd.mjs';
import { runFixConsumer } from './fix-consumer-cmd.mjs';
import { runCapabilityProbe } from './capability-probe-cmd.mjs';

applyWorkspaceEnv();

function usage() {
    console.error(`Harness — chạy trong thư mục harness-eso sau git clone.

  ./install.sh
  ./harness up

  harnessctl init profile <consumer-path> [--plan] [--id <id>] [--name <name>] [--host-mode dual-ide|all-ide|claude|superset]
  harnessctl host-pack status|refresh|add-ide|remove-ide [consumer | --project <id>]
  harnessctl verify consumer <path|--project <id>> [--json] [--strict] [--out <dir>]
  harnessctl fix consumer <path|--project <id>> [--dry-run] [--from-latest] [--force-provision] [--no-provision] [--strict] [--json]
  harnessctl token-diet [consumer | --project <id>] [--json]
  harnessctl capability probe [consumer | --project <id>] [--recipe <id>] [--provider <module.mjs>] [--json]
  harnessctl configure list | harnessctl configure use <id>
  harnessctl observatory up|down|restart|status|health|logs|build|smoke [--project <id>]
  harnessctl console up|down|restart|status|health|logs|build

  Một URL: http://127.0.0.1:8792 (tab Projects để thêm dự án)`);
}

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];

    if (cmd === 'init' && argv[1] === 'profile') {
        console.log(JSON.stringify(runInitProfile(argv.slice(2)), null, 2));
        return;
    }

    if (cmd === 'configure') {
        if (argv[1] === 'add') {
            console.error('configure add is removed — use: harnessctl init profile <consumer-path>');
            process.exit(2);
        }
        if (argv[1] === 'list') {
            console.log(JSON.stringify(configureListCli(), null, 2));
            return;
        }
        if (argv[1] === 'use' && argv[2]) {
            console.log(JSON.stringify(configureUseCli(argv[2]), null, 2));
            return;
        }
        usage();
        process.exit(2);
    }

    if (cmd === 'project' && argv[1] === 'init') {
        console.error('use: harnessctl init profile <consumer-path>');
        process.exit(2);
    }

    if (cmd === 'capability') {
        if (argv[1] !== 'probe') {
            console.error('usage: harnessctl capability probe [consumer | --project <id>] [--recipe <id>] [--provider <module.mjs>] [--json]');
            process.exit(2);
        }
        await runCapabilityProbe(argv.slice(2));
        return;
    }

    if (cmd === 'host-pack') {
        const sub = argv[1];
        if (!sub) {
            console.error('usage: harnessctl host-pack status|refresh|add-ide|remove-ide [consumer|--project <id>]');
            process.exit(2);
        }
        runHostPack(sub, argv.slice(2));
        return;
    }

    if (cmd === 'console') {
        const sub = argv[1];
        if (!sub) {
            usage();
            process.exit(2);
        }
        runConsole(sub, argv.slice(2));
        return;
    }

    if (cmd === 'observatory' || cmd === 'observe') {
        const sub = argv[1];
        if (!sub) {
            usage();
            process.exit(2);
        }
        const rest = [];
        let projectId;
        let port;
        let consumerPath;
        for (let i = 2; i < argv.length; i++) {
            const a = argv[i];
            if (a === '--project') projectId = argv[++i];
            else if (a === '--port') port = Number.parseInt(argv[++i], 10);
            else if (a === '--consumer') consumerPath = argv[++i];
            else if (a.startsWith('-')) rest.push(a);
            else if (!consumerPath) consumerPath = a;
            else rest.push(a);
        }
        runObservatory(sub, rest, { projectId, port, consumerPath });
        return;
    }

    if (cmd === 'storage') {
        const cfg = loadConfig(process.cwd());
        if (!cfg.ok) {
            console.error(cfg.reason || 'invalid harness.config.json');
            process.exit(1);
        }
        if (argv[1] === 'status') {
            console.log(JSON.stringify(storageStatus(cfg), null, 2));
            return;
        }
        if (argv[1] === 'gc') {
            const dryRun = argv.includes('--dry-run');
            console.log(JSON.stringify(runStorageGc(cfg, { dryRun }), null, 2));
            return;
        }
        usage();
        process.exit(2);
    }

    if (cmd === 'token-diet' || (cmd === 'check' && argv[1] === 'token-diet')) {
        const sliceFrom = cmd === 'check' ? 2 : 1;
        runTokenDiet(argv.slice(sliceFrom));
        return;
    }

    if (cmd === 'verify' && argv[1] === 'consumer') {
        runVerifyConsumer(argv.slice(2));
        return;
    }

    if (cmd === 'fix' && argv[1] === 'consumer') {
        runFixConsumer(argv.slice(2));
        return;
    }

    usage();
    process.exit(2);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
