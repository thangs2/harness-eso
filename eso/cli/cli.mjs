#!/usr/bin/env node
import { initProfileV2 } from './init-profile.mjs';

function usage() {
    console.error(`eso v2 cli
Usage:
  node eso/cli/cli.mjs init profile <consumer-path> [--id <id>] [--dry-run|--plan] [--force]
`);
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length < 2) {
        usage();
        process.exit(2);
    }

    const command = argv[0];
    const subcommand = argv[1];

    if (command === 'init' && subcommand === 'profile') {
        const rest = argv.slice(2);
        let consumerPath = null;
        const opts = {
            dryRun: false,
            force: false,
            projectId: null,
        };

        for (let i = 0; i < rest.length; i++) {
            const arg = rest[i];
            if (arg === '--dry-run' || arg === '--plan') {
                opts.dryRun = true;
            } else if (arg === '--force') {
                opts.force = true;
            } else if (arg === '--id') {
                opts.projectId = rest[++i];
            } else if (!arg.startsWith('-')) {
                if (!consumerPath) {
                    consumerPath = arg;
                } else {
                    console.error(`❌ Unexpected positional argument: ${arg}`);
                    process.exit(2);
                }
            } else {
                console.error(`❌ Unknown flag: ${arg}`);
                process.exit(2);
            }
        }

        if (!consumerPath) {
            console.error('❌ Missing required <consumer-path>');
            process.exit(2);
        }

        try {
            const result = initProfileV2(consumerPath, opts);
            console.log(JSON.stringify(result, null, 2));
            process.exit(0);
        } catch (err) {
            console.error(`❌ init profile failed: ${err.message}`);
            if (err.code === 'UNKNOWN_CONSUMER') {
                process.exit(2);
            }
            process.exit(1);
        }
    } else {
        usage();
        process.exit(2);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
