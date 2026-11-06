import {
    Body,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Post,
    UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../../../common/guards/auth.guard.js';
import { CurrentProject } from '../../../../common/decorators/current-project.decorator.js';
import { GraphService, isTurnPath } from '../../application/services/graph.service.js';
import { GraphIndexDto } from '../dto/graph-index.dto.js';
import { GraphRebuildDto } from '../dto/graph-rebuild.dto.js';
import { GraphQueryDto } from '../dto/graph-query.dto.js';
import { GraphDocsDto } from '../dto/graph-docs.dto.js';

/**
 * Graph store API — API-28/29 (write) and API-30…34 (Q1–Q5, read).
 *
 * Contract paths in `sdlc/07.technical/03.api/` are written `POST /v1/graph:index` etc.
 * Fastify reads `:` as a route parameter and refuses more than one such route at the same
 * position, so the routable form is the slash form below (`OPEN-API-GRAPH-06`). The response
 * shapes, status codes and codes stay exactly as contracted.
 *
 * Every route is off-path. `x-eso-turn-phase: judging` marks a request made while a turn is
 * judging; graph work is refused with 409 HEAVY_ON_TURN before the store is touched.
 */
@Controller('v1/graph')
@UseGuards(AuthGuard)
export class GraphController {
    constructor(private readonly graphService: GraphService) {}

    @Post('index')
    @HttpCode(HttpStatus.ACCEPTED)
    index(
        @Body() dto: GraphIndexDto,
        @CurrentProject() project: string,
        @Headers('x-eso-turn-phase') turnPhase?: string
    ) {
        return this.graphService.index(project, dto, this.graphService.turnPhase(turnPhase));
    }

    @Post('rebuild')
    @HttpCode(HttpStatus.ACCEPTED)
    rebuild(
        @Body() dto: GraphRebuildDto,
        @CurrentProject() project: string,
        @Headers('x-eso-turn-phase') turnPhase?: string
    ) {
        return this.graphService.rebuild(project, dto, this.graphService.turnPhase(turnPhase));
    }

    /** Generic form: `{ question: "Q1".."Q5", ...inputs }`. */
    @Post('query')
    @HttpCode(HttpStatus.OK)
    query(
        @Body() dto: GraphQueryDto,
        @CurrentProject() project: string,
        @Headers('x-eso-turn-phase') turnPhase?: string
    ) {
        return this.graphService.query(project, dto.question || 'Q1', dto, this.graphService.turnPhase(turnPhase));
    }

    /** API-35: docs graph around one code/topology node. */
    @Post('docs')
    @HttpCode(HttpStatus.OK)
    docs(
        @Body() dto: GraphDocsDto,
        @CurrentProject() project: string,
        @Headers('x-eso-turn-phase') turnPhase?: string
    ) {
        return this.graphService.docs(project, dto, this.graphService.turnPhase(turnPhase));
    }

    @Post('q1')
    @HttpCode(HttpStatus.OK)
    q1(@Body() dto: GraphQueryDto, @CurrentProject() project: string, @Headers('x-eso-turn-phase') turnPhase?: string) {
        return this.graphService.query(project, 'Q1', dto, this.graphService.turnPhase(turnPhase));
    }

    @Post('q2')
    @HttpCode(HttpStatus.OK)
    q2(@Body() dto: GraphQueryDto, @CurrentProject() project: string, @Headers('x-eso-turn-phase') turnPhase?: string) {
        return this.graphService.query(project, 'Q2', dto, this.graphService.turnPhase(turnPhase));
    }

    @Post('q3')
    @HttpCode(HttpStatus.OK)
    q3(@Body() dto: GraphQueryDto, @CurrentProject() project: string, @Headers('x-eso-turn-phase') turnPhase?: string) {
        return this.graphService.query(project, 'Q3', dto, this.graphService.turnPhase(turnPhase));
    }

    @Post('q4')
    @HttpCode(HttpStatus.OK)
    q4(@Body() dto: GraphQueryDto, @CurrentProject() project: string, @Headers('x-eso-turn-phase') turnPhase?: string) {
        return this.graphService.query(project, 'Q4', dto, this.graphService.turnPhase(turnPhase));
    }

    @Post('q5')
    @HttpCode(HttpStatus.OK)
    q5(@Body() dto: GraphQueryDto, @CurrentProject() project: string, @Headers('x-eso-turn-phase') turnPhase?: string) {
        return this.graphService.query(project, 'Q5', dto, this.graphService.turnPhase(turnPhase));
    }
}
