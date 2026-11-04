import { Injectable } from '@nestjs/common';
import { ProjectAccessPort } from '../../application/ports/project-access.port.js';

/**
 * Default binding while the deployment has a single operator token and no
 * per-project policy: every project the token can reach is readable.
 *
 * It is a binding, not a policy — a deployment that configures project scopes
 * replaces this provider, and the S1 surface then renders `ST4 denied`
 * (403 `OUT_OF_SCOPE`) for everything outside them.
 */
@Injectable()
export class AllowAllProjectAccess implements ProjectAccessPort {
    canReadProject(_project: string): boolean {
        return true;
    }
}
