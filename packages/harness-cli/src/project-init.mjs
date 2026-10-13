import { configureAdd, configureList, configureUse } from '@mu/harness-foundation/workspace';
import { applyWorkspaceEnv, ESO_ROOT } from './workspace-env.mjs';

export { ESO_ROOT };

function withEnv(fn) {
    applyWorkspaceEnv();
    return fn();
}

export function configureAddCli(opts) {
    return withEnv(() => configureAdd(opts));
}

export function configureListCli() {
    return withEnv(() => configureList());
}

export function configureUseCli(projectId) {
    return withEnv(() => configureUse(projectId));
}

export function initProject(opts) {
    return configureAddCli(opts);
}
