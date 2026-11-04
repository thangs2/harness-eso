import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { DatabaseService } from './database.service.js';
import { AuthGuard } from './auth.guard.js';

export async function createNestFastifyControlPlane({
    db = null,
    authToken = 'secret-token',
} = {}): Promise<NestFastifyApplication> {
    const fastifyAdapter = new FastifyAdapter();
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        fastifyAdapter,
        { logger: false }
    );

    const dbService = app.get(DatabaseService);
    if (db) {
        dbService.setDatabase(db);
    }

    const authGuard = app.get(AuthGuard);
    if (authToken) {
        authGuard.setToken(authToken);
    }

    await app.init();
    return app;
}
