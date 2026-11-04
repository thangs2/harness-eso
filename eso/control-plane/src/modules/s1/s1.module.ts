import { Module } from '@nestjs/common';
import { S1Controller } from './api/controllers/s1.controller.js';

@Module({
    controllers: [S1Controller],
})
export class S1Module {}
