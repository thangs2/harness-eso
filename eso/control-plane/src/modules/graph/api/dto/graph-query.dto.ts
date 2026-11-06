import { IsIn, IsOptional, IsString } from 'class-validator';

const QUESTIONS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];

/**
 * API-30..34 request body. `question` is only used by the generic `/v1/graph/query`;
 * the per-question routes set it from the route. All fields are optional here because each
 * question needs a different one — the service returns MISSING_INPUT when the required
 * input for that question is absent.
 */
export class GraphQueryDto {
    @IsString()
    @IsOptional()
    project?: string;

    @IsString()
    @IsOptional()
    build_id?: string;

    @IsIn(QUESTIONS)
    @IsOptional()
    question?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

    @IsString()
    @IsOptional()
    symbol?: string;

    @IsString()
    @IsOptional()
    file?: string;

    @IsString()
    @IsOptional()
    table?: string;

    @IsString()
    @IsOptional()
    column?: string;

    @IsString()
    @IsOptional()
    endpoint_id?: string;

    @IsString()
    @IsOptional()
    slice_id?: string;
}
