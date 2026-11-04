import { Injectable, type ErrorHandler } from '@angular/core';

export interface AppError {
    title: string;
    message: string;
    code?: string;
    timestamp: string;
}

@Injectable({
    providedIn: 'root',
})
export class GlobalErrorHandler implements ErrorHandler {
    handleError(error: unknown): void {
        const appError = this.normalizeError(error);
        // Announce or log structured error without unhandled promise crash
        if (typeof console !== 'undefined' && console.error) {
            console.error('[GlobalErrorHandler]', appError.code, appError.message);
        }
    }

    normalizeError(error: unknown): AppError {
        const timestamp = new Date().toISOString();
        if (error instanceof Error) {
            return {
                title: error.name || 'Application Error',
                message: error.message,
                timestamp,
            };
        }
        if (typeof error === 'object' && error !== null) {
            const errObj = error as Record<string, unknown>;
            return {
                title: String(errObj['title'] || 'Error'),
                message: String(errObj['detail'] || errObj['message'] || 'An unexpected error occurred'),
                code: errObj['code'] ? String(errObj['code']) : undefined,
                timestamp,
            };
        }
        return {
            title: 'Unknown Error',
            message: String(error),
            timestamp,
        };
    }
}
