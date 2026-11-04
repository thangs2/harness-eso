import { Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
    private db: any = null;

    setDatabase(dbInstance: any) {
        this.db = dbInstance;
    }

    getDatabase(): any {
        return this.db;
    }

    isHealthy(): boolean {
        if (!this.db) return false;
        try {
            if (typeof this.db.get === 'function') {
                this.db.get('SELECT 1');
                return true;
            }
            if (typeof this.db.all === 'function') {
                this.db.all('SELECT 1');
                return true;
            }
            return true;
        } catch {
            return false;
        }
    }

    async onModuleDestroy() {
        if (this.db && typeof this.db.close === 'function') {
            try {
                this.db.close();
            } catch {}
        }
    }
}
