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
    authProject?: string;
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

    // Demo UI on :4200 calls this server directly.
    app.enableCors({
        origin: ['http://localhost:4200', 'http://127.0.0.1:4200'],
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    });

    // Wire auth config
    const authConfig = app.get(AuthConfig);
    if (authConfig) {
        if (options.authToken !== undefined) {
            authConfig.token = options.authToken;
        }
        if (options.authProject !== undefined) {
            authConfig.project = options.authProject;
        } else if (!authConfig.project && process.env.ESO_AUTH_PROJECT) {
            authConfig.project = process.env.ESO_AUTH_PROJECT;
        }
    }

    return app;
}
