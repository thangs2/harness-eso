/**
 * Project access port — the server-side authority for "may this caller read
 * this project?" (AC-UI-01-04: `OUT_OF_SCOPE`, one sentence for *not found*
 * and *no permission*).
 *
 * The S1 surface only renders the decision; it never derives it. The port is
 * deliberately separate from `AuthGuard`, which answers *who* is calling, not
 * *what* they may read.
 */
export const PROJECT_ACCESS = Symbol('PROJECT_ACCESS');

export interface ProjectAccessPort {
    canReadProject(project: string): boolean;
}
