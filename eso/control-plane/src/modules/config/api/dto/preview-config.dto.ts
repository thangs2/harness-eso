import { IsNotEmpty, IsObject, IsString } from 'class-validator';

export class PreviewConfigDto {
    @IsString()
    @IsNotEmpty()
    project: string;

    @IsObject()
    @IsNotEmpty()
    pendingChange: Record<string, any>;
}
