import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * API-35 request body. `project` is read only so the auth guard can reject a body naming a
 * different project; the value used is always @CurrentProject.
 */
export class GraphDocsDto {
    @IsString()
    @IsOptional()
    project?: string;

    @IsString()
    @IsOptional()
    build_id?: string;

    @IsObject()
    node: { kind: string; id: string };
}
