import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../../../../common/infrastructure/database.service.js';

@Controller('health')
export class HealthController {
    constructor(private readonly dbService: DatabaseService) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    check() {
        const healthy = this.dbService.isHealthy();
        if (!healthy) {
            throw new ServiceUnavailableException({
                status: 'unhealthy',
                error: 'STORE_UNAVAILABLE',
                code: 'STORE_UNAVAILABLE',
                type: 'https://eso.dev/errors/store-unavailable',
                title: 'Service Unavailable',
                detail: 'Control plane store check failed',
            });
        }
        return {
            status: 'ok',
            service: 'eso-control-plane',
            timestamp: new Date().toISOString(),
        };
    }

    @Get('live')
    @HttpCode(HttpStatus.OK)
    live() {
        return {
            status: 'ok',
            service: 'eso-control-plane',
            check: 'live',
            timestamp: new Date().toISOString(),
        };
    }

    @Get('ready')
    @HttpCode(HttpStatus.OK)
    ready() {
        return this.check();
    }
}
