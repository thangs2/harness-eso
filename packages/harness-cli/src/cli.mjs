#!/usr/bin/env node
import path from 'node:path';
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
import { runVerifyHost } from './verify-host-cmd.mjs';
import { runDshBridge } from './dsh-bridge-cmd.mjs';
import { runDoctorDsh } from './doctor-dsh-cmd.mjs';
import { runCheckContract } from './check-contract-cmd.mjs';
import { runCheckIsolation } from './check-isolation-cmd.mjs';
import { runCheckMigration } from './check-migration-cmd.mjs';

applyWorkspaceEnv();

function usage() {
    console.error(`Harness — chạy trong thư mục harness-eso sau git clone.

  ./install.sh
  ./harness up

  harnessctl init profile <consumer-path> [--plan] [--id <id>] [--name <name>] [--host-mode dual-ide|all-ide|claude|superset]
  harnessctl host-pack status|refresh|add-ide|remove-ide [consumer | --project <id>]
  harnessctl verify consumer <path|--project <id>> [--json] [--strict] [--out <dir>]
  harnessctl verify host [consumer | --project <id>] [--recipe <id>] [--require-native] [--json]
  harnessctl fix consumer <path|--project <id>> [--dry-run] [--from-latest] [--force-provision] [--no-provision] [--strict] [--json]
  harnessctl fix docs [consumer] [--dry-run]
  harnessctl token-diet [consumer | --project <id>] [--json]
  harnessctl capability probe [consumer | --project <id>] [--recipe <id>] [--provider <module.mjs>] [--json]
  harnessctl doctor dsh [--profile <id>] [--home <path>] [--json]
  harnessctl dsh bridge --out <dir> [--config-path <path>] [--project-dir <dir>] [--force]
  harnessctl check contract <before.json> <after.json> [--direction response|request] [--json]
  harnessctl check project <file...> --tables <table,table> [--json]
  harnessctl check migration <file...> [--json]
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

    if (cmd === 'check' && argv[1] === 'migration') {
        runCheckMigration(argv.slice(2));
        return;
    }

    if (cmd === 'check' && argv[1] === 'isolation') {
        runCheckIsolation(argv.slice(2));
        return;
    }

    if (cmd === 'check' && argv[1] === 'contract') {
        runCheckContract(argv.slice(2));
        return;
    }

    if (cmd === 'doctor' && argv[1] === 'dsh') {
        runDoctorDsh(argv.slice(2));
        return;
    }

    if (cmd === 'dsh' && argv[1] === 'bridge') {
        runDshBridge(argv.slice(2));
        return;
    }

    if (cmd === 'capability') {
        if (argv[1] !== 'probe') {
            console.error('usage: harnessctl capability probe [consumer | --project <id>] [--recipe <id>] [--provider <module.mjs>] [--json]');
            process.exit(2);
        }
        /*
         * `argv.slice(3)`, not `slice(2)`: the verb 'probe' is already consumed, and forwarding it made
         * the subcommand's parser read it as the positional consumer — so `capability probe <path>` ran
         * the probe against a directory named "probe", and `capability probe` alone died on it. The
         * usage line above has always promised a positional consumer.
         */
        await runCapabilityProbe(argv.slice(3));
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

    if (cmd === 'verify' && argv[1] === 'host') {
        runVerifyHost(argv.slice(2));
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

    /*
     * `fix docs` exists on its own because `fix consumer` only acts on failing checks, and a consumer
     * that passes T1.1 would never pick up a newer checklist or diagnostic script. Those files are how
     * an operator learns what changed, so refreshing them must not depend on them being out of date.
     */
    if (cmd === 'fix' && argv[1] === 'docs') {
        const rest = argv.slice(2);
        const dryRun = rest.includes('--dry-run');
        const positional = rest.filter((a) => !a.startsWith('-'));
        const root = path.resolve(positional[0] || process.cwd());
        const { syncConsumerDocs } = await import('./fix-consumer-cmd.mjs');
        const result = syncConsumerDocs(root, { dryRun });
        console.log(JSON.stringify({ root, ...result }, null, 2));
        process.exit(result.ok ? 0 : 1);
    }

    usage();
    process.exit(2);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
