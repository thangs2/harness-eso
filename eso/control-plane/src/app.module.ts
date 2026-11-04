import { Module } from '@nestjs/common';
import { DatabaseModule } from './common/infrastructure/database.module.js';
import { AuthModule } from './common/guards/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ConfigModule } from './modules/config/config.module.js';
import { S1Module } from './modules/s1/s1.module.js';

@Module({
    imports: [DatabaseModule, AuthModule, HealthModule, ConfigModule, S1Module],
})
export class AppModule {}
