import {
    Controller,
    Get,
    Post,
    Query,
    Body,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '../../../../common/guards/auth.guard.js';
import { ConfigService } from '../../application/services/config.service.js';
import { PreviewConfigDto } from '../dto/preview-config.dto.js';
import { SaveConfigDto } from '../dto/save-config.dto.js';

@Controller('config')
@UseGuards(AuthGuard)
export class ConfigController {
    constructor(private readonly configService: ConfigService) {}

    @Get()
    getConfig(
        @Query('project') project: string,
        @Query('version') version?: string
    ) {
        return this.configService.getConfig(project, version);
    }

    @Post('preview')
    @HttpCode(HttpStatus.OK)
    previewConfig(@Body() body: PreviewConfigDto) {
        return this.configService.previewConfig(body);
    }

    @Post()
    @HttpCode(HttpStatus.OK)
    saveConfig(@Body() body: SaveConfigDto) {
        return this.configService.saveConfig(body);
    }
}
