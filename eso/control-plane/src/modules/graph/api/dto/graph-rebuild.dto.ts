import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/** API-29 request body. The source is recovered from `graph_index_run` for this build_id. */
export class GraphRebuildDto {
    @IsString()
    @IsOptional()
    project?: string;

    @IsString()
    @IsNotEmpty()
    build_id: string;

    /** Optional only when the build was never indexed; then rebuild behaves like API-28. */
    @IsObject()
    @IsOptional()
    source?: { kind: string; solution_path?: string };
}
