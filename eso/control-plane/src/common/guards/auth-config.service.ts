import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthConfig {
    token: string | null = null;
    project: string | null = process.env.ESO_AUTH_PROJECT || null;
}
