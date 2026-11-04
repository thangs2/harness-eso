import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

@Controller('health')
export class HealthController {
    constructor(private readonly dbService: DatabaseService) {}

    @Get()
    async checkHealth() {
        try {
            await this.dbService.healthCheck();
            return {
                status: 'ok',
                service: 'eso-control-plane',
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            throw new HttpException(
                {
                    status: 'unhealthy',
                    error: 'STORE_UNAVAILABLE',
                    message: err.message,
                },
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }
    }
}
