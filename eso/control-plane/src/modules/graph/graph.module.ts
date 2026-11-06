import { Module } from '@nestjs/common';
import { GraphController } from './api/controllers/graph.controller.js';
import { GraphService } from './application/services/graph.service.js';

@Module({
    controllers: [GraphController],
    providers: [GraphService],
    exports: [GraphService],
})
export class GraphModule {}
