import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ConfigController } from './config.controller.js';
import { S1Controller } from './s1.controller.js';
import { DatabaseService } from './database.service.js';
import { AuthGuard } from './auth.guard.js';

@Module({
    controllers: [HealthController, ConfigController, S1Controller],
    providers: [DatabaseService, AuthGuard],
    exports: [DatabaseService, AuthGuard],
})
export class AppModule {}
