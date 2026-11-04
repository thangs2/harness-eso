import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthConfig {
    token: string | null = null;
}
