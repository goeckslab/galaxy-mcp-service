import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { errors, type Adapter, type AdapterConstructor, type AdapterPayload } from "oidc-provider";
import pg from "pg";
import { storedSubscription, type EventLease, type EventState, type SubscribeParams, type UnsubscribeParams } from "@galaxy-mcp-service/protocol";

import { LoginExpired, type LoginTokens } from "./galaxy-login.js";

/** A site authorized with the user's API key, or by signing in to the site's login provider. */
export type Connection =
  | { instance: string; baseUrl: string; apiKey: string }
  | { instance: string; baseUrl: string; login: LoginTokens & { expired?: boolean } };

/** What a Galaxy request runs with: an API key, or a sign-in's access token sent as a bearer. */
export type UsableConnection = EventLease["connection"];

export interface Credential {
  accountId: string;
  clientId: string;
  instance: string;
  audience: string;
  connections: Connection[];
}

// Access tokens are refreshed when less than this remains, so a request rarely outlives its token.
const REFRESH_BEFORE_MS = 120000;
const needsRefresh = (connection: Connection) => "login" in connection && !connection.login.expired
  && connection.login.expiresAt - Date.now() < REFRESH_BEFORE_MS;
/** An expired sign-in is left out: Galaxy would refuse it, and the user has to sign in again. */
export const usableConnections = (connections: Connection[]): UsableConnection[] => connections.flatMap(connection =>
  !("login" in connection) ? [{ instance: connection.instance, baseUrl: connection.baseUrl, apiKey: connection.apiKey }]
    : connection.login.expired ? []
      : [{ instance: connection.instance, baseUrl: connection.baseUrl, apiKey: connection.login.accessToken, tokenType: "bearer" as const }]);

export interface ManagedCredential {
  grantId: string;
  clientId: string;
  expiresAt: number;
  connections: { instance: string; baseUrl: string }[];
}

export async function createStore(
  connectionString: string, key: Buffer,
  refresh?: (instance: string, refreshToken: string) => Promise<LoginTokens>,
) {
  if (key.length !== 32) throw new Error("Broker encryption key must contain 32 bytes.");
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  pool.on("error", () => console.error("Broker database connection failed."));
  try { await pool.query(`
    CREATE TABLE IF NOT EXISTS galaxy_broker_models (
      model text NOT NULL, id text NOT NULL, payload bytea NOT NULL,
      expires_at bigint NOT NULL, grant_id text, uid text, user_code text, consumed bigint,
      PRIMARY KEY (model, id)
    );
    CREATE INDEX IF NOT EXISTS galaxy_broker_grants ON galaxy_broker_models (grant_id);
    CREATE INDEX IF NOT EXISTS galaxy_broker_uids ON galaxy_broker_models (model, uid);
    CREATE TABLE IF NOT EXISTS galaxy_broker_credentials (
      grant_id text PRIMARY KEY, account_id text NOT NULL, client_id text NOT NULL,
      instance text NOT NULL, audience text NOT NULL, payload bytea NOT NULL, expires_at bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS galaxy_broker_limits (
      id text PRIMARY KEY, count integer NOT NULL, expires_at bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS galaxy_broker_events (
      id text PRIMARY KEY, grant_id text NOT NULL REFERENCES galaxy_broker_credentials(grant_id) ON DELETE CASCADE,
      instance text NOT NULL, payload bytea NOT NULL, expires_at bigint NOT NULL,
      next_at bigint, lease_until bigint NOT NULL DEFAULT 0, lease_token text,
      revision integer NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS galaxy_broker_events_due ON galaxy_broker_events(next_at);
  `); } catch (error) { await pool.end(); throw error; }
  const hash = (value: string) => createHmac("sha256", key).update(value).digest("hex");
  function encrypt(value: unknown, aad: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }
  function decrypt<T>(data: Buffer, aad: string): T {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8")) as T;
  }
  async function revoke(grant: string) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("DELETE FROM galaxy_broker_models WHERE grant_id = $1", [grant]);
      await db.query("DELETE FROM galaxy_broker_credentials WHERE grant_id = $1", [grant]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  class PostgresAdapter implements Adapter {
    constructor(private readonly name: string) {}
    async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
      if (!expiresIn || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error("Broker state must have a finite lifetime.");
      }
      const lookup = hash(`${this.name}:${id}`);
      const grantId = this.name === "Grant" ? id : payload.grantId;
      await pool.query(`INSERT INTO galaxy_broker_models
        (model, id, payload, expires_at, grant_id, uid, user_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (model,id) DO UPDATE SET payload = EXCLUDED.payload,
          expires_at = EXCLUDED.expires_at, grant_id = EXCLUDED.grant_id,
          uid = EXCLUDED.uid, user_code = EXCLUDED.user_code`, [
        this.name, lookup, encrypt(payload, `${this.name}:${lookup}`), Date.now() + expiresIn * 1000,
        grantId ? hash(`grant:${grantId}`) : null,
        payload.uid ? hash(`uid:${payload.uid}`) : null,
        payload.userCode ? hash(`user-code:${payload.userCode}`) : null,
      ]);
    }
    private async lookup(column: "id" | "uid" | "user_code", value: string) {
      const result = await pool.query<{ id: string; payload: Buffer; consumed: string | null }>(
        `SELECT id,payload,consumed FROM galaxy_broker_models WHERE model=$1 AND ${column}=$2 AND expires_at>$3`,
        [this.name, value, Date.now()],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const payload = decrypt<AdapterPayload>(row.payload, `${this.name}:${row.id}`);
      if (row.consumed) payload.consumed = Number(row.consumed);
      return payload;
    }
    find(id: string) { return this.lookup("id", hash(`${this.name}:${id}`)); }
    findByUid(uid: string) { return this.lookup("uid", hash(`uid:${uid}`)); }
    findByUserCode(code: string) { return this.lookup("user_code", hash(`user-code:${code}`)); }
    async consume(id: string) {
      const lookup = hash(`${this.name}:${id}`);
      const result = await pool.query(`UPDATE galaxy_broker_models SET consumed=$4
        WHERE model=$1 AND id=$2 AND consumed IS NULL AND expires_at>$3 RETURNING id`,
      [this.name, lookup, Date.now(), Math.floor(Date.now() / 1000)]);
      if (result.rowCount !== 1) {
        const existing = await pool.query<{ grant_id: string | null }>(
          "SELECT grant_id FROM galaxy_broker_models WHERE model=$1 AND id=$2", [this.name, lookup],
        );
        if (existing.rows[0]?.grant_id) await revoke(existing.rows[0].grant_id);
        throw new errors.InvalidGrant("Authorization is no longer valid.");
      }
    }
    async destroy(id: string) {
      if (this.name === "Grant") return revoke(hash(`grant:${id}`));
      await pool.query("DELETE FROM galaxy_broker_models WHERE model=$1 AND id=$2", [this.name, hash(`${this.name}:${id}`)]);
    }
    revokeByGrantId(grantId: string) { return revoke(hash(`grant:${grantId}`)); }
  }
  const binding = (grant: string, value: Omit<Credential, "connections">) =>
    JSON.stringify([grant, value.accountId, value.clientId, value.instance, value.audience]);
  const eventId = (grantId: string, params: UnsubscribeParams) => `sub_${hash(JSON.stringify([
    "run-event", hash(`grant:${grantId}`), params.name, params.arguments.instance,
    params.arguments.kind, params.arguments.runId, params.delivery.url,
  ]))}`;
  type EventRow = { id: string; grant_id: string; instance: string; payload: Buffer; expires_at: string; revision: number; lease_token: string; next_at: string | null };
  const eventPayload = (row: EventRow) => storedSubscription.parse(decrypt(row.payload, `RunEvent:${row.id}:${row.grant_id}`));
  type CredentialRow = { account_id: string; client_id: string; instance: string; audience: string; payload: Buffer };
  const rowValue = (row: CredentialRow) => ({ accountId: row.account_id, clientId: row.client_id, instance: row.instance, audience: row.audience });
  /**
   * Refreshes the sign-ins of a grant that are about to expire. The row lock makes concurrent
   * requests wait for one refresh: the provider accepts each refresh token only once.
   */
  async function refreshLogins(grant: string): Promise<Connection[] | undefined> {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query<CredentialRow>("SELECT * FROM galaxy_broker_credentials WHERE grant_id=$1 AND expires_at>$2 FOR UPDATE", [grant, Date.now()]);
      const row = result.rows[0];
      if (!row) { await db.query("ROLLBACK"); return undefined; }
      const value = rowValue(row);
      const { connections } = decrypt<Pick<Credential, "connections">>(row.payload, binding(grant, value));
      let changed = false;
      for (const [index, connection] of connections.entries()) {
        if (!refresh || !needsRefresh(connection) || !("login" in connection)) continue;
        try {
          connections[index] = { ...connection, login: await refresh(connection.instance, connection.login.refreshToken) };
          changed = true;
        } catch (error) {
          // A temporary failure keeps the current token; the next request tries again.
          if (error instanceof LoginExpired) { connections[index] = { ...connection, login: { ...connection.login, expired: true } }; changed = true; }
        }
      }
      if (changed) await db.query("UPDATE galaxy_broker_credentials SET payload=$1 WHERE grant_id=$2", [encrypt({ connections }, binding(grant, value)), grant]);
      await db.query("COMMIT");
      return connections;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally { db.release(); }
  }
  async function eventConnection(grant: string, instance: string, db: Pick<pg.Pool, "query"> = pool) {
    const result = await db.query<CredentialRow>("SELECT * FROM galaxy_broker_credentials WHERE grant_id=$1 AND expires_at>$2", [grant, Date.now()]);
    const row = result.rows[0];
    if (!row) return undefined;
    return decrypt<Pick<Credential, "connections">>(row.payload, binding(grant, rowValue(row))).connections.find(value => value.instance === instance);
  }
  /** The connection a run-event worker sends to Galaxy, refreshed outside any lock the caller holds on the event. */
  async function workerConnection(grant: string, instance: string, db: Pick<pg.Pool, "query"> = pool): Promise<UsableConnection | undefined> {
    const connection = await eventConnection(grant, instance, db);
    if (!connection) return undefined;
    const current = needsRefresh(connection) ? (await refreshLogins(grant))?.find(value => value.instance === instance) : connection;
    return current ? usableConnections([current])[0] : undefined;
  }
  return {
    adapter: PostgresAdapter as AdapterConstructor,
    async saveCredential(grantId: string, value: Credential, expiresAt: number) {
      const grant = hash(`grant:${grantId}`);
      // No upsert: an existing grant must never be redirected to a different account/instance/key.
      await pool.query(`INSERT INTO galaxy_broker_credentials
        (grant_id,account_id,client_id,instance,audience,payload,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [grant, value.accountId, value.clientId, value.instance, value.audience,
        encrypt({ connections: value.connections }, binding(grant, value)), expiresAt]);
    },
    async credential(grantId: string): Promise<Credential | undefined> {
      const grant = hash(`grant:${grantId}`);
      const result = await pool.query<CredentialRow>("SELECT * FROM galaxy_broker_credentials WHERE grant_id=$1 AND expires_at>$2", [grant, Date.now()]);
      const row = result.rows[0];
      if (!row) return undefined;
      const value = rowValue(row);
      return { ...value, ...decrypt<Pick<Credential, "connections">>(row.payload, binding(grant, value)) };
    },
    /** The grant's credential with sign-ins refreshed when they are about to expire. */
    async freshCredential(grantId: string): Promise<Credential | undefined> {
      const credential = await this.credential(grantId);
      if (!credential?.connections.some(needsRefresh)) return credential;
      const connections = await refreshLogins(hash(`grant:${grantId}`));
      return connections && { ...credential, connections };
    },
    async hasAccount(accountId: string) {
      const result = await pool.query("SELECT 1 FROM galaxy_broker_credentials WHERE account_id=$1 AND expires_at>$2 LIMIT 1", [accountId, Date.now()]);
      return result.rowCount === 1;
    },
    async managedCredential(accountId: string, grantId: string): Promise<ManagedCredential | undefined> {
      const grant = hash(`grant:${grantId}`);
      const result = await pool.query<{
        grant_id: string; account_id: string; client_id: string; instance: string; audience: string; payload: Buffer; expires_at: string;
      }>("SELECT * FROM galaxy_broker_credentials WHERE grant_id=$1 AND account_id=$2 AND expires_at>$3", [grant, accountId, Date.now()]);
      const row = result.rows[0];
      if (!row) return undefined;
      const value = { accountId: row.account_id, clientId: row.client_id, instance: row.instance, audience: row.audience };
      const payload = decrypt<Pick<Credential, "connections">>(row.payload, binding(row.grant_id, value));
      return {
        grantId: row.grant_id,
        clientId: row.client_id,
        expiresAt: Number(row.expires_at),
        connections: payload.connections.map(({ instance, baseUrl }) => ({ instance, baseUrl })),
      };
    },
    async removeConnection(accountId: string, grantId: string, instance: string) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const result = await db.query<{
          grant_id: string; account_id: string; client_id: string; instance: string; audience: string; payload: Buffer;
        }>("SELECT * FROM galaxy_broker_credentials WHERE grant_id=$1 AND account_id=$2 AND expires_at>$3 FOR UPDATE", [grantId, accountId, Date.now()]);
        const row = result.rows[0];
        if (!row) { await db.query("ROLLBACK"); return false; }
        const value = { accountId: row.account_id, clientId: row.client_id, instance: row.instance, audience: row.audience };
        const payload = decrypt<Pick<Credential, "connections">>(row.payload, binding(row.grant_id, value));
        const connections = payload.connections.filter(connection => connection.instance !== instance);
        if (connections.length === payload.connections.length) { await db.query("ROLLBACK"); return false; }
        if (!connections.length) {
          await db.query("DELETE FROM galaxy_broker_models WHERE grant_id=$1", [grantId]);
          await db.query("DELETE FROM galaxy_broker_credentials WHERE grant_id=$1", [grantId]);
        } else {
          const next = { ...value, instance: connections[0]!.instance };
          await db.query("UPDATE galaxy_broker_credentials SET instance=$1,payload=$2 WHERE grant_id=$3", [
            next.instance, encrypt({ connections }, binding(row.grant_id, next)), grantId,
          ]);
          await db.query("DELETE FROM galaxy_broker_events WHERE grant_id=$1 AND instance=$2", [grantId, instance]);
        }
        await db.query("COMMIT");
        return true;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally { db.release(); }
    },
    async revokeCredential(accountId: string, grantId: string) {
      const owned = await pool.query("SELECT 1 FROM galaxy_broker_credentials WHERE grant_id=$1 AND account_id=$2 AND expires_at>$3", [grantId, accountId, Date.now()]);
      if (owned.rowCount !== 1) return false;
      await revoke(grantId);
      return true;
    },
    async prepareEvent(grantId: string, params: SubscribeParams) {
      const id = eventId(grantId, params);
      const result = await pool.query<EventRow>("SELECT * FROM galaxy_broker_events WHERE id=$1 AND expires_at>$2", [id, Date.now()]);
      const existing = result.rows[0] ? eventPayload(result.rows[0]) : undefined;
      return { id, verification_required: !existing || existing.delivery.secret !== params.delivery.secret || existing.verifiedAt < Date.now() - 300000,
        verified_at: existing?.verifiedAt ?? null };
    },
    async subscribeEvent(grantId: string, params: SubscribeParams, verifiedAt: number) {
      const id = eventId(grantId, params);
      const grant = hash(`grant:${grantId}`);
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const owned = await db.query<{ expires_at: string }>("SELECT expires_at FROM galaxy_broker_credentials WHERE grant_id=$1 AND expires_at>$2 FOR UPDATE", [grant, Date.now()]);
        if (!owned.rows[0] || !await eventConnection(grant, params.arguments.instance, db)) throw new Error("Event authorization is no longer active.");
        const result = await db.query<EventRow>("SELECT * FROM galaxy_broker_events WHERE id=$1 AND expires_at>$2 FOR UPDATE", [id, Date.now()]);
        const existing = result.rows[0] ? eventPayload(result.rows[0]) : undefined;
        const count = await db.query<{ count: string }>("SELECT count(*) FROM galaxy_broker_events WHERE grant_id=$1 AND expires_at>$2", [grant, Date.now()]);
        if (!existing && Number(count.rows[0]!.count) >= 50) throw new Error("Too many run subscriptions for this connection.");
        const now = Date.now();
        const expiresAt = Math.min(Number(owned.rows[0].expires_at), now + Math.min(params.ttlMs ?? 86400000, 86400000));
        const rotated = existing && existing.delivery.secret !== params.delivery.secret;
        const subscription = storedSubscription.parse({ id, arguments: params.arguments, delivery: params.delivery,
          expiresAt, verifiedAt, state: existing?.state ?? { phase: "watching", attempts: 0 },
          ...(rotated ? { previousSecret: existing.delivery.secret, previousSecretUntil: now + 60000 }
            : existing?.previousSecret ? { previousSecret: existing.previousSecret, previousSecretUntil: existing.previousSecretUntil } : {}),
        });
        const nextAt = ["delivered", "stopped"].includes(subscription.state.phase) ? null : result.rows[0]?.next_at ?? now;
        await db.query(`INSERT INTO galaxy_broker_events (id,grant_id,instance,payload,expires_at,next_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,
          expires_at=EXCLUDED.expires_at,next_at=EXCLUDED.next_at,lease_until=0,lease_token=NULL,revision=galaxy_broker_events.revision+1`,
        [id, grant, params.arguments.instance, encrypt(subscription, `RunEvent:${id}:${grant}`), expiresAt, nextAt]);
        await db.query("COMMIT");
        return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
    async unsubscribeEvent(grantId: string, params: UnsubscribeParams) {
      await pool.query("DELETE FROM galaxy_broker_events WHERE id=$1 AND grant_id=$2", [eventId(grantId, params), hash(`grant:${grantId}`)]);
    },
    async claimEvent(audience: string): Promise<EventLease | null> {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const now = Date.now();
        const result = await db.query<EventRow>(`SELECT e.* FROM galaxy_broker_events e
          JOIN galaxy_broker_credentials c ON c.grant_id=e.grant_id
          WHERE e.next_at<=$1 AND e.lease_until<=$1 AND e.expires_at>$1 AND c.expires_at>$1 AND c.audience=$2
          ORDER BY e.next_at LIMIT 1 FOR UPDATE OF e SKIP LOCKED`, [now, audience]);
        const row = result.rows[0];
        if (!row) { await db.query("COMMIT"); return null; }
        const connection = await workerConnection(row.grant_id, row.instance, db);
        if (!connection) {
          await db.query("DELETE FROM galaxy_broker_events WHERE id=$1", [row.id]);
          await db.query("COMMIT"); return null;
        }
        const lease = randomBytes(24).toString("base64url");
        await db.query("UPDATE galaxy_broker_events SET lease_until=$2,lease_token=$3,revision=revision+1 WHERE id=$1", [row.id, now + 120000, lease]);
        await db.query("COMMIT");
        return { subscription: eventPayload(row), revision: row.revision + 1, lease, connection };
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
    async checkEvent(id: string, revision: number, lease: string): Promise<EventLease | null> {
      const result = await pool.query<EventRow>("SELECT * FROM galaxy_broker_events WHERE id=$1 AND revision=$2 AND lease_token=$3 AND lease_until>$4 AND expires_at>$4", [id, revision, lease, Date.now()]);
      const row = result.rows[0];
      const connection = row ? await workerConnection(row.grant_id, row.instance) : undefined;
      return row && connection ? { subscription: eventPayload(row), revision: row.revision, lease, connection } : null;
    },
    async saveEvent(id: string, revision: number, lease: string, state: EventState, delayMs: number, release: boolean) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const result = await db.query<EventRow>("SELECT * FROM galaxy_broker_events WHERE id=$1 AND revision=$2 AND lease_token=$3 AND lease_until>$4 AND expires_at>$4 FOR UPDATE", [id, revision, lease, Date.now()]);
        const row = result.rows[0];
        if (!row || !await eventConnection(row.grant_id, row.instance, db)) { await db.query("ROLLBACK"); return null; }
        const next = { ...eventPayload(row), state };
        const due = ["delivered", "stopped"].includes(state.phase) ? null : Date.now() + delayMs;
        await db.query(`UPDATE galaxy_broker_events SET payload=$2,next_at=$3,revision=revision+1,
          lease_until=CASE WHEN $4 THEN 0 ELSE lease_until END,lease_token=CASE WHEN $4 THEN NULL ELSE lease_token END WHERE id=$1`,
        [id, encrypt(next, `RunEvent:${id}:${row.grant_id}`), due, release]);
        await db.query("COMMIT");
        return { revision: revision + 1 };
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
    async rateLimit(ip: string) {
      const now = Date.now();
      const result = await pool.query<{ count: number }>(`INSERT INTO galaxy_broker_limits (id,count,expires_at)
        VALUES ($1,1,$2) ON CONFLICT (id) DO UPDATE SET count=galaxy_broker_limits.count+1 RETURNING count`,
      [hash(`rate:${Math.floor(now / 60000)}:${ip}`), now + 120000]);
      return result.rows[0]!.count <= 30;
    },
    async cleanup() {
      await pool.query("DELETE FROM galaxy_broker_events WHERE expires_at<=$1", [Date.now()]);
      await pool.query("DELETE FROM galaxy_broker_models WHERE expires_at<=$1", [Date.now()]);
      await pool.query("DELETE FROM galaxy_broker_credentials WHERE expires_at<=$1", [Date.now()]);
      await pool.query("DELETE FROM galaxy_broker_limits WHERE expires_at<=$1", [Date.now()]);
    },
    close: () => pool.end(),
    ready: () => pool.query("SELECT 1"),
  };
}
