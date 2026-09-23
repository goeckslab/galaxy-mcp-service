import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { errors, type Adapter, type AdapterConstructor, type AdapterPayload } from "oidc-provider";
import pg from "pg";

export interface Credential {
  accountId: string;
  clientId: string;
  instance: string;
  audience: string;
  apiKey: string;
  baseUrl: string;
  connections?: { instance: string; apiKey: string; baseUrl: string }[];
}

export async function createStore(connectionString: string, key: Buffer) {
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
  const binding = (grant: string, value: Omit<Credential, "apiKey" | "baseUrl">) =>
    JSON.stringify([grant, value.accountId, value.clientId, value.instance, value.audience]);
  return {
    adapter: PostgresAdapter as AdapterConstructor,
    async saveCredential(grantId: string, value: Credential, expiresAt: number) {
      const grant = hash(`grant:${grantId}`);
      // No upsert: an existing grant must never be redirected to a different account/instance/key.
      await pool.query(`INSERT INTO galaxy_broker_credentials
        (grant_id,account_id,client_id,instance,audience,payload,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [grant, value.accountId, value.clientId, value.instance, value.audience,
        encrypt({ apiKey: value.apiKey, baseUrl: value.baseUrl, connections: value.connections }, binding(grant, value)), expiresAt]);
    },
    async credential(grantId: string): Promise<Credential | undefined> {
      const grant = hash(`grant:${grantId}`);
      const result = await pool.query<{
        account_id: string; client_id: string; instance: string; audience: string; payload: Buffer;
      }>("SELECT * FROM galaxy_broker_credentials WHERE grant_id=$1 AND expires_at>$2", [grant, Date.now()]);
      const row = result.rows[0];
      if (!row) return undefined;
      const value = { accountId: row.account_id, clientId: row.client_id, instance: row.instance, audience: row.audience };
      return { ...value, ...decrypt<Pick<Credential, "apiKey" | "baseUrl" | "connections">>(row.payload, binding(grant, value)) };
    },
    async hasAccount(accountId: string) {
      const result = await pool.query("SELECT 1 FROM galaxy_broker_credentials WHERE account_id=$1 AND expires_at>$2 LIMIT 1", [accountId, Date.now()]);
      return result.rowCount === 1;
    },
    async rateLimit(ip: string) {
      const now = Date.now();
      const result = await pool.query<{ count: number }>(`INSERT INTO galaxy_broker_limits (id,count,expires_at)
        VALUES ($1,1,$2) ON CONFLICT (id) DO UPDATE SET count=galaxy_broker_limits.count+1 RETURNING count`,
      [hash(`rate:${Math.floor(now / 60000)}:${ip}`), now + 120000]);
      return result.rows[0]!.count <= 30;
    },
    async cleanup() {
      await pool.query("DELETE FROM galaxy_broker_models WHERE expires_at<=$1", [Date.now()]);
      await pool.query("DELETE FROM galaxy_broker_credentials WHERE expires_at<=$1", [Date.now()]);
      await pool.query("DELETE FROM galaxy_broker_limits WHERE expires_at<=$1", [Date.now()]);
    },
    close: () => pool.end(),
    ready: () => pool.query("SELECT 1"),
  };
}
