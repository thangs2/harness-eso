import { InjectionToken } from '@angular/core';
import type { ControlPlaneApiClient } from '../../../../../libs/api-client/index.js';

export interface AppConfig {
    apiBaseUrl: string;
    environment: 'development' | 'production' | 'test';
}

export const CONTROL_PLANE_API_CLIENT = new InjectionToken<ControlPlaneApiClient>('CONTROL_PLANE_API_CLIENT');
export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG');
