import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
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

        return true;
    }
}
