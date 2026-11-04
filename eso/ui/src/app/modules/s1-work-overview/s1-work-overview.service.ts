/**
 * Angular 22 Client Service: S1 Work Overview (Client sinh từ contract / D-72)
 */

export class S1WorkOverviewClient {
    private baseUrl: string;
    private token: string | null;

    constructor({ baseUrl = 'http://127.0.0.1:8792', token = null } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.token = token;
    }

    setToken(token: string) {
        this.token = token;
    }

    async fetchS1Page(project: string = 'default'): Promise<{ html: string; status: number }> {
        const headers: Record<string, string> = {};
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        const res = await fetch(`${this.baseUrl}/s1?project=${encodeURIComponent(project)}`, {
            method: 'GET',
            headers,
        });

        const html = await res.text();
        return {
            status: res.status,
            html,
        };
    }
}
