import { Module } from '@nestjs/common';
import { ConsumerController } from './api/controllers/consumer.controller.js';
import { ConsumerService } from './application/services/consumer.service.js';
import { ConsumerRepository } from './infrastructure/persistence/consumer.repository.js';

@Module({
    controllers: [ConsumerController],
    providers: [ConsumerService, ConsumerRepository],
    exports: [ConsumerService],
})
export class ConsumerModule {}
