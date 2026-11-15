import fs from 'fs';
import path from 'path';
import {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
  Notification,
} from 'pg';

export type SignalPayload = Record<string, unknown>;
type SignalHandler = (targetId: string, payload: SignalPayload) => void;

export class Database {
  private static pool: Pool | null = null;
  private static listener: PoolClient | null = null;
  private static signalHandler: SignalHandler | null = null;
  private static listenerStarting = false;
  private static migrationsReady = false;

  public static async initialize(): Promise<void> {
    if (this.pool) return;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || /replace|example\.com|localhost:5432\/change/i.test(connectionString)) {
      throw new Error('DATABASE_URL must point to a real PostgreSQL database. Refusing to start without durable storage.');
    }

    const max = Number.parseInt(process.env.PG_POOL_MAX || '10', 10);
    this.pool = new Pool({
      connectionString,
      max: Number.isFinite(max) && max > 0 ? Math.min(max, 50) : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
      application_name: 'mahi-remote-backend',
    });

    this.pool.on('error', (error) => {
      // Pool-level idle client errors are logged; the pool replaces the client.
      console.error('[database] idle client error', error.message);
    });

    await this.pool.query('SELECT 1');
    await this.runMigrations();
    this.migrationsReady = true;
    console.log('[database] PostgreSQL connected and migrations are current');
  }

  private static getPool(): Pool {
    if (!this.pool || !this.migrationsReady) {
      throw new Error('Database is not initialized. Call Database.initialize() before accepting traffic.');
    }
    return this.pool;
  }

  public static async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<QueryResult<T>> {
    return this.getPool().query<T>(text, values as any[]);
  }

  public static async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private static async runMigrations(): Promise<void> {
    const migrationDirectory = path.resolve(process.cwd(), 'migrations');
    if (!fs.existsSync(migrationDirectory)) {
      throw new Error(`Database migration directory is missing: ${migrationDirectory}`);
    }

    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = fs.readdirSync(migrationDirectory)
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort();

    if (migrationFiles.length === 0) {
      throw new Error('No backend SQL migrations were found.');
    }

    for (const migrationName of migrationFiles) {
      const alreadyApplied = await this.pool!.query(
        'SELECT 1 FROM schema_migrations WHERE migration_name = $1',
        [migrationName]
      );
      if (alreadyApplied.rowCount) continue;

      const sql = fs.readFileSync(path.join(migrationDirectory, migrationName), 'utf8');
      await this.transaction(async (client) => {
        // A transaction-scoped advisory lock serializes migrations even when the
        // migration ledger row does not exist yet.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('mahi-remote-schema-migrations'))");
        const locked = await client.query(
          'SELECT 1 FROM schema_migrations WHERE migration_name = $1 FOR UPDATE',
          [migrationName]
        );
        if (locked.rowCount) return;
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT DO NOTHING',
          [migrationName]
        );
      });
      console.log(`[database] applied migration ${migrationName}`);
    }
  }

  public static setSignalHandler(handler: SignalHandler): void {
    this.signalHandler = handler;
  }

  public static async startSignalListener(): Promise<void> {
    if (this.listener || this.listenerStarting) return;
    this.listenerStarting = true;
    try {
      const client = await this.getPool().connect();
      this.listener = client;
      await client.query('LISTEN mahi_signaling');

      client.on('notification', (notification: Notification) => {
        void this.handleNotification(notification);
      });
      client.on('error', (error: Error) => {
        console.error('[database] signaling listener error', error.message);
        if (this.listener === client) this.listener = null;
        try { client.release(true); } catch { /* already released */ }
        const retry = setTimeout(() => {
          void this.startSignalListener().catch((reconnectError) => {
            console.error('[database] signaling listener reconnect failed', reconnectError);
          });
        }, 3000);
        retry.unref?.();
      });
      client.on('end', () => {
        if (this.listener === client) this.listener = null;
      });
      console.log('[database] cross-instance signaling listener ready');
    } finally {
      this.listenerStarting = false;
    }
  }

  private static async handleNotification(notification: Notification): Promise<void> {
    const eventId = notification.payload;
    if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) return;
    try {
      const result = await this.query<{ target_id: string; payload: SignalPayload }>(
        'SELECT target_id, payload FROM signaling_outbox WHERE event_id = $1',
        [eventId]
      );
      const event = result.rows[0];
      if (event && this.signalHandler) this.signalHandler(event.target_id, event.payload);
    } catch (error) {
      console.error('[database] could not read signaling outbox event', error);
    }
  }

  public static async publishSignal(targetId: string, payload: SignalPayload): Promise<void> {
    const eventId = cryptoRandomUuid();
    await this.transaction(async (client) => {
      await client.query(
        'INSERT INTO signaling_outbox (event_id, target_id, payload) VALUES ($1, $2, $3::jsonb)',
        [eventId, targetId, JSON.stringify(payload)]
      );
      await client.query("SELECT pg_notify('mahi_signaling', $1)", [eventId]);
    });
  }

  public static async cleanupEphemeralRecords(): Promise<void> {
    await this.query('DELETE FROM signaling_outbox WHERE created_at < NOW() - INTERVAL \'10 minutes\'');
    await this.query('DELETE FROM device_challenges WHERE expires_at < NOW() - INTERVAL \'1 day\'');
    await this.query(
      "UPDATE pairing_requests SET status = 'EXPIRED', decided_at = NOW() WHERE status = 'PENDING' AND expires_at <= NOW()"
    );
    await this.query('DELETE FROM rate_limit_counters WHERE updated_at < NOW() - INTERVAL \'1 day\'');
  }

  public static async isReady(): Promise<boolean> {
    if (!this.pool || !this.migrationsReady) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  public static async close(): Promise<void> {
    this.migrationsReady = false;
    if (this.listener) {
      try { await this.listener.query('UNLISTEN mahi_signaling'); } catch { /* closing */ }
      try { this.listener.release(); } catch { /* already released */ }
      this.listener = null;
    }
    if (this.pool) {
      const current = this.pool;
      this.pool = null;
      await current.end();
    }
  }
}

function cryptoRandomUuid(): string {
  // UUIDs are generated locally by Node's cryptographic random source.
  return require('crypto').randomUUID();
}
