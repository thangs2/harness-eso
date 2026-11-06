import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../../../common/guards/auth.guard.js';
import { CurrentProject } from '../../../../common/decorators/current-project.decorator.js';
import { ConsumerService } from '../../application/services/consumer.service.js';
import { ConsumerProfileDto } from '../dto/consumer-profile.dto.js';

@Controller('api/v1/consumers')
@UseGuards(AuthGuard)
export class ConsumerController {
    constructor(private readonly consumerService: ConsumerService) {}

    @Get()
    list(@CurrentProject() project: string) {
        return this.consumerService.list(project);
    }

    @Get(':project')
    get(@Param('project') project: string, @CurrentProject() currentProject: string) {
        return this.consumerService.get(project, currentProject);
    }

    @Post('plan')
    @HttpCode(HttpStatus.OK)
    plan(@Body() body: ConsumerProfileDto, @CurrentProject() project: string) {
        return this.consumerService.plan(body, project);
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    create(@Body() body: ConsumerProfileDto, @CurrentProject() project: string) {
        return this.consumerService.create(body, project);
    }

    @Put(':project')
    update(
        @Param('project') project: string,
        @Body() body: ConsumerProfileDto,
        @CurrentProject() currentProject: string
    ) {
        return this.consumerService.update(project, body, currentProject);
    }
}
