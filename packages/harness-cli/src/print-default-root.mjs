import fs from 'node:fs';
import { applyWorkspaceEnv } from './workspace-env.mjs';
import { loadWorkspace, resolveProject, workspaceFile } from '@mu/harness-foundation/workspace';

applyWorkspaceEnv();
// Read the workspace from wherever it actually lives — `HARNESS_PRODUCT_STATE_DIR` or `~/.harness`.
// Hard-coding `<checkout>/.harness/workspace.json` meant this reported "no default project" for every
// install whose state had been moved out of the source tree.
const wsPath = workspaceFile();
if (!fs.existsSync(wsPath)) {
    process.exit(1);
}
const ws = loadWorkspace();
const p = resolveProject(ws, null);
const out = p.rootHost || p.root;
if (!out) process.exit(1);
process.stdout.write(out);
