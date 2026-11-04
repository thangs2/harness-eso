import { Global, Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard.js';
import { AuthConfig } from './auth-config.service.js';

@Global()
@Module({
    providers: [AuthConfig, AuthGuard],
    exports: [AuthConfig, AuthGuard],
})
export class AuthModule {}
