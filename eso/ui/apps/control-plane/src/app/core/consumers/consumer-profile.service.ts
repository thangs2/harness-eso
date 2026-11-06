import { Injectable, inject } from '@angular/core';
import { CONTROL_PLANE_API_CLIENT } from '../tokens.js';
import type { ConsumerListResponse, ConsumerPlan, ConsumerProfile } from '../../../../../../libs/api-client/types.js';

@Injectable({ providedIn: 'root' })
export class ConsumerProfileService {
    private readonly client = inject(CONTROL_PLANE_API_CLIENT, { optional: true });

    list(): Promise<ConsumerListResponse> {
        if (!this.client) return Promise.resolve({ items: [] });
        return this.client.listConsumers();
    }

    get(project: string): Promise<ConsumerProfile> {
        if (!this.client) throw new Error('API client chưa được cấu hình');
        return this.client.getConsumer(project);
    }

    plan(profile: ConsumerProfile): Promise<ConsumerPlan> {
        if (!this.client) throw new Error('API client chưa được cấu hình');
        return this.client.planConsumer(profile);
    }

    create(profile: ConsumerProfile): Promise<ConsumerProfile> {
        if (!this.client) throw new Error('API client chưa được cấu hình');
        return this.client.createConsumer(profile);
    }

    update(project: string, profile: ConsumerProfile): Promise<ConsumerProfile> {
        if (!this.client) throw new Error('API client chưa được cấu hình');
        return this.client.updateConsumer(project, profile);
    }
}
