import { Module } from '@nestjs/common';
import { ConfigController } from './api/controllers/config.controller.js';
import { ConfigService } from './application/services/config.service.js';

@Module({
    controllers: [ConfigController],
    providers: [ConfigService],
    exports: [ConfigService],
})
export class ConfigModule {}
