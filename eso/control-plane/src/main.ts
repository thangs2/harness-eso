import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { DatabaseService } from './common/infrastructure/database.service.js';
import { AuthConfig } from './common/guards/auth-config.service.js';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';

export interface NestControlPlaneOptions {
    db?: any;
    authToken?: string;
    port?: number;
    host?: string;
}

export async function createNestFastifyControlPlane(
    options: NestControlPlaneOptions = {}
): Promise<NestFastifyApplication> {
    const adapter = new FastifyAdapter();
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        adapter,
        { logger: false }
    );

    // Global validation pipe
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: { enableImplicitConversion: false },
        })
    );

    // Global Problem Details RFC 9457 exception filter
    app.useGlobalFilters(new ProblemDetailsFilter());

    // Enable graceful shutdown
    app.enableShutdownHooks();

    // Wire database service
    if (options.db) {
        const dbService = app.get(DatabaseService);
        if (dbService) {
            dbService.setDatabase(options.db);
        }
    }

    // Wire auth config
    if (options.authToken !== undefined) {
        const authConfig = app.get(AuthConfig);
        if (authConfig) {
            authConfig.token = options.authToken;
        }
    }

    return app;
}
