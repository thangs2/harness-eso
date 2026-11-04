import { Injectable } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';

@Injectable()
export class DatabaseService {
    private db: any = null;

    constructor() {}

    setDatabase(dbInstance: any) {
        this.db = dbInstance;
    }

    getDatabase() {
        return this.db;
    }

    async healthCheck(): Promise<boolean> {
        if (!this.db) {
            throw new Error('Database instance unavailable');
        }
        try {
            if (typeof this.db.get === 'function') {
                this.db.get('SELECT 1');
            } else if (typeof this.db.all === 'function') {
                this.db.all('SELECT 1');
            } else if (typeof this.db.prepare === 'function') {
                this.db.prepare('SELECT 1').get();
            } else {
                throw new Error('Database query method unavailable');
            }
            return true;
        } catch (err) {
            throw new Error(`STORE_UNAVAILABLE: ${err.message}`);
        }
    }
}
