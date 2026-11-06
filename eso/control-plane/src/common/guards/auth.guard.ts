import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
    ForbiddenException,
} from '@nestjs/common';
import { AuthConfig } from './auth-config.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(private readonly authConfig: AuthConfig) {}

    canActivate(context: ExecutionContext): boolean {
        const expectedToken = this.authConfig.token;
        if (!expectedToken) {
            throw new UnauthorizedException({
                type: 'https://eso.dev/errors/unauthorized',
                title: 'Unauthorized',
                status: 401,
                code: 'UNAUTHORIZED',
                error: 'UNAUTHORIZED',
                detail: 'Authentication required: server authentication token not configured or missing',
            });
        }

        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers?.authorization;

        if (!authHeader || typeof authHeader !== 'string') {
            throw new UnauthorizedException({
                type: 'https://eso.dev/errors/unauthorized',
                title: 'Unauthorized',
                status: 401,
                code: 'UNAUTHORIZED',
                error: 'UNAUTHORIZED',
                detail: 'Missing or invalid Authorization header',
            });
        }

        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match || match[1] !== expectedToken) {
            throw new UnauthorizedException({
                type: 'https://eso.dev/errors/unauthorized',
                title: 'Unauthorized',
                status: 401,
                code: 'UNAUTHORIZED',
                error: 'UNAUTHORIZED',
                detail: 'Bearer token mismatch or invalid',
            });
        }

        // Token authenticated. Now enforce tenant project context (MVP 1 token = 1 project).
        const configuredProject = this.authConfig.project;
        if (!configuredProject) {
            throw new ForbiddenException({
                type: 'https://eso.dev/errors/forbidden',
                title: 'Forbidden',
                status: 403,
                code: 'AUTH_PROJECT_MISSING',
                error: 'AUTH_PROJECT_MISSING',
                detail: 'Authentication project scope not configured on server (fail-closed)',
            });
        }

        request.esoProject = configuredProject;

        // Check if request specifies a project in query, params, or body
        const requestedProject =
            (request.query && typeof request.query.project === 'string' && request.query.project) ||
            (request.params && typeof request.params.project === 'string' && request.params.project) ||
            (request.body && typeof request.body === 'object' && typeof request.body.project === 'string' && request.body.project) ||
            null;

        if (requestedProject && requestedProject !== configuredProject) {
            throw new ForbiddenException({
                type: 'https://eso.dev/errors/forbidden',
                title: 'Forbidden',
                status: 403,
                code: 'OUT_OF_SCOPE',
                error: 'OUT_OF_SCOPE',
                detail: `Project '${requestedProject}' is out of scope for authenticated token`,
            });
        }

        return true;
    }
}
