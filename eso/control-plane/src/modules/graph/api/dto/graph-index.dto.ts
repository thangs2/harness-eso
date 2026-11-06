import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * API-28 request body. `project` is accepted only so the auth guard can reject a body that names
 * another project; the value actually used always comes from @CurrentProject.
 */
export class GraphIndexDto {
    @IsString()
    @IsOptional()
    project?: string;

    @IsString()
    @IsNotEmpty()
    build_id: string;

    @IsObject()
    source: { kind: string; solution_path?: string };
}
