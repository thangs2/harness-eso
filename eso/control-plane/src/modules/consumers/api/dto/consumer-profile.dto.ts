import { IsArray, IsInt, IsObject, IsOptional, IsString, Matches, Min } from 'class-validator';

export class ConsumerProfileDto {
    @IsString()
    @Matches(/^[a-z][a-z0-9-]{1,31}$/, { message: 'id must be a lower-case slug (2–32 chars)' })
    id: string;

    @IsString()
    name: string;

    @IsString()
    root: string;

    @IsOptional()
    @IsString()
    repoUrl?: string;

    @IsOptional()
    @IsString()
    hostMode?: string;

    @IsOptional()
    @IsInt()
    @Min(1)
    observePort?: number;

    @IsString()
    sdlcRoot: string;

    @IsObject()
    profile: { recipe: string; hostProfile: string; description?: string };

    @IsObject()
    integration: Record<string, any>;

    @IsArray()
    zones: Array<{ name: string; path: string; headerProfile?: string }>;

    @IsString()
    headerProfile: string;

    @IsOptional()
    @IsString()
    presetVersion?: string;

    @IsObject()
    tools: Record<string, any>;

    @IsObject()
    team: { roles: string[]; presets?: string[] };

    @IsObject()
    gates: Record<string, any>;

    @IsObject()
    sources: Record<string, any>;

    @IsArray()
    protectedPaths: string[];
}
