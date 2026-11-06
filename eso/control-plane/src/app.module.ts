import { Module } from '@nestjs/common';
import { DatabaseModule } from './common/infrastructure/database.module.js';
import { AuthModule } from './common/guards/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ConfigModule } from './modules/config/config.module.js';
import { WorkOverviewModule } from './modules/work-overview/work-overview.module.js';
import { ConsumerModule } from './modules/consumers/consumer.module.js';
import { FlowModule } from './modules/flow/flow.module.js';
import { DebtModule } from './modules/debt/debt.module.js';
import { ScopeModule } from './modules/scope/scope.module.js';
import { GraphModule } from './modules/graph/graph.module.js';

@Module({
    imports: [DatabaseModule, AuthModule, HealthModule, ConfigModule, WorkOverviewModule, ConsumerModule, FlowModule, DebtModule, ScopeModule, GraphModule],
})
export class AppModule {}
