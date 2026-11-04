import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class SaveConfigDto {
    @IsString()
    @IsNotEmpty()
    project: string;

    @IsObject()
    @IsNotEmpty()
    config: Record<string, any>;

    @IsString()
    @IsOptional()
    current_hash?: string;

    @IsString()
    @IsOptional()
    preview_hash?: string;

    @IsString()
    @IsOptional()
    operator?: string;
}
