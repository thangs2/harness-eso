import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
    private expectedToken: string = 'secret-token';

    setToken(token: string) {
        this.expectedToken = token;
    }

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest();
        const authHeader = req.headers['authorization'] || req.headers['x-eso-token'];

        let providedToken = null;
        if (authHeader) {
            providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
        }

        if (!providedToken || (this.expectedToken && providedToken !== this.expectedToken)) {
            throw new HttpException(
                { error: 'UNAUTHORIZED', message: 'Token required' },
                HttpStatus.UNAUTHORIZED
            );
        }

        return true;
    }
}
