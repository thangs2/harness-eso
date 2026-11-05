import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../../../common/guards/auth.guard.js';
import { ConsumerService } from '../../application/services/consumer.service.js';
import { ConsumerProfileDto } from '../dto/consumer-profile.dto.js';

@Controller('api/v1/consumers')
@UseGuards(AuthGuard)
export class ConsumerController {
    constructor(private readonly consumerService: ConsumerService) {}

    @Get()
    list() {
        return this.consumerService.list();
    }

    @Get(':project')
    get(@Param('project') project: string) {
        return this.consumerService.get(project);
    }

    @Post('plan')
    @HttpCode(HttpStatus.OK)
    plan(@Body() body: ConsumerProfileDto) {
        return this.consumerService.plan(body);
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    create(@Body() body: ConsumerProfileDto) {
        return this.consumerService.create(body);
    }

    @Put(':project')
    update(@Param('project') project: string, @Body() body: ConsumerProfileDto) {
        return this.consumerService.update(project, body);
    }
}
