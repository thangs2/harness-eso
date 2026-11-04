import { Module } from '@nestjs/common';
import { S1Controller } from './api/controllers/s1.controller.js';
import { EvidenceRepository } from './infrastructure/evidence.repository.js';

@Module({
    controllers: [S1Controller],
    providers: [EvidenceRepository],
})
export class S1Module {}
