import type { S1TurnListResponse, ConfigPreviewDto, ProblemDetailsDto } from './types.js';

export class ControlPlaneApiClient {
    private baseUrl: string;
    private tokenProvider: () => string | null;

    constructor(options: { baseUrl?: string; tokenProvider?: () => string | null } = {}) {
        this.baseUrl = (options.baseUrl || 'http://127.0.0.1:8792').replace(/\/$/, '');
        this.tokenProvider = options.tokenProvider || (() => null);
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Accept': 'application/json, text/html',
        };
        const token = this.tokenProvider();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    async getS1Work(project: string = 'default'): Promise<S1TurnListResponse> {
        const url = `${this.baseUrl}/api/v1/s1?project=${encodeURIComponent(project)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: this.getHeaders(),
        });

        if (!res.ok) {
            let errorDetail: ProblemDetailsDto;
            try {
                errorDetail = await res.json() as ProblemDetailsDto;
            } catch {
                errorDetail = {
                    title: 'HTTP Error',
                    status: res.status,
                    detail: res.statusText,
                };
            }
            throw errorDetail;
        }

        return await res.json() as S1TurnListResponse;
    }

    async getS1Html(project: string = 'default'): Promise<{ html: string; status: number }> {
        const url = `${this.baseUrl}/s1?project=${encodeURIComponent(project)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: this.getHeaders(),
        });
        const html = await res.text();
        return { html, status: res.status };
    }

    async previewConfig(project: string): Promise<ConfigPreviewDto> {
        const url = `${this.baseUrl}/api/config/preview?project=${encodeURIComponent(project)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: this.getHeaders(),
        });
        if (!res.ok) {
            throw new Error(`Preview failed with status ${res.status}`);
        }
        return await res.json() as ConfigPreviewDto;
    }

    async saveConfig(project: string, config: Record<string, unknown>, hash: string): Promise<{ success: boolean; hash: string }> {
        const url = `${this.baseUrl}/api/config/save`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                ...this.getHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ project, config, hash }),
        });
        if (!res.ok) {
            if (res.status === 409) {
                throw new Error('CONFIG_STALE_HASH: Configuration modified by another session. Please reload preview.');
            }
            throw new Error(`Save failed with status ${res.status}`);
        }
        return await res.json() as { success: boolean; hash: string };
    }
}
