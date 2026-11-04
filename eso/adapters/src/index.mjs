/**
 * @mu/eso-adapters — ESO Host Adapters & Provider Election Domain
 */

export {
    BRANCH_ORDER,
    KNOWN_HOSTS,
    ERROR_SILENT_SWITCH,
    ERROR_SILENT_NONE,
    electCapabilityProvider,
    handleMidTurnBranchFailure,
    setCapabilityPin,
    loadCapabilityPins,
    recordTurnProviderAudit,
    queryTurnProviderAudit,
    queryBatchProviderAudit,
    invokeCapabilityProvider,
} from './election.mjs';

export {
    ensureEvidenceSchema,
    recordTurnEvidence,
    readTurnEvidence,
    listTurnEvidence,
} from './host-bridge.mjs';
