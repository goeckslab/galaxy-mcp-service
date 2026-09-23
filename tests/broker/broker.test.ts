import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBroker, type BrokerConfig } from "../../apps/broker/src/broker.js";
import { createStore } from "../../apps/broker/src/store.js";
import { loadUniversalAuth } from "../../apps/service/src/auth.js";
import { modernRequest, startTestService } from "../helpers/service.js";

const exec = promisify(execFile);
const resource = "http://127.0.0.1/mcp";
const callback = "http://127.0.0.1/callback";
const keys = { us: "fixture-alice-us-key", eu: "fixture-bob-eu-key" };
const otherClientSecret = "fixture-other-confidential-client-secret";
const apiRequests: string[] = [];
let container: string | undefined;
let databaseUrl: string;
let galaxy: Server;
let server: Server;
let broker: Awaited<ReturnType<typeof createBroker>>;
let config: BrokerConfig;
let handler: RequestListener = (_req, res) => { res.writeHead(503).end(); };
let database: pg.Pool;

function address(server: Server) { return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
async function close(server: Server | undefined) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

class Browser {
  cookies = new Map<string, string>();
  async request(url: string, init: RequestInit = {}) {
    expect(new URL(url).origin).toBe(config.issuer);
    const headers = new Headers(init.headers);
    headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const split = pair.indexOf("=");
      this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
}

async function authorization(client = "client-a", overrides: Record<string, string> = {}, browser = new Browser()) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: client, redirect_uri: callback, response_type: "code", scope: "galaxy:full offline_access",
    resource, state: "fixture-state", code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), ...overrides,
  });
  const start = await browser.request(`${config.issuer}/auth?${params}`);
  expect(start.status).toBe(303);
  const location = new URL(start.headers.get("location")!, config.issuer).href;
  expect(location).toContain("/interaction/");
  const form = await browser.request(location);
  expect(form.status).toBe(200);
  expect(form.headers.get("referrer-policy")).toBe("same-origin");
  const html = await form.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  return { browser, location, csrf: csrf!, verifier, client, html };
}

async function consent(auth: Awaited<ReturnType<typeof authorization>>, instance: "us" | "eu" = "us", changes: Record<string, string> = {}) {
  return auth.browser.request(auth.location, {
    method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: auth.csrf, instance, api_key: keys[instance], consent: "yes", action: "connect", ...changes }),
  });
}

async function resume(auth: Awaited<ReturnType<typeof authorization>>, response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await response.text();
  expect(html).not.toMatch(/fixture-.*-key|<script|<form/);
  const target = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)?.[1];
  expect(target).toBe(auth.location.replace("/interaction/", "/auth/"));
  expect(html).toContain(`href="${target}"`);
  return auth.browser.request(target!);
}

async function codeFor(instance: "us" | "eu" = "us", client = "client-a", browser?: Browser, parameters: Record<string, string> = {}, connectionFields?: Record<string, string>) {
  const auth = await authorization(client, parameters, browser);
  let response = await resume(auth, await (connectionFields ? auth.browser.request(auth.location, {
    method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: auth.csrf, consent: "yes", action: "connect", ...connectionFields }),
  }) : consent(auth, instance)));
  for (let step = 0; step < 10; step++) {
    if (response.status === 200) {
      const html = await response.text();
      expect(response.headers.get("content-security-policy") || "").not.toContain("form-action 'self'");
      const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
      expect(action).toBeTruthy();
      expect(new URL(action!, config.issuer).pathname).toBe("/session/end/confirm");
      const body = new URLSearchParams();
      for (const field of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) body.set(field[1]!, field[2]!);
      response = await auth.browser.request(new URL(action!, config.issuer).href, {
        method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" }, body,
      });
      continue;
    }
    expect(response.status, await response.clone().text()).toBe(303);
    const location = new URL(response.headers.get("location")!, config.issuer);
    if (location.origin !== config.issuer) {
      expect(location.origin + location.pathname).toBe(callback);
      expect(location.searchParams.get("state")).toBe("fixture-state");
      expect(location.searchParams.get("error")).toBeNull();
      const code = location.searchParams.get("code");
      expect(code).toBeTruthy();
      return { ...auth, code: code! };
    }
    response = await auth.browser.request(location.href);
  }
  throw new Error("Authorization did not finish.");
}

async function tokenRequest(form: Record<string, string>) {
  return fetch(`${config.issuer}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form),
  });
}
async function exchange(auth: Awaited<ReturnType<typeof codeFor>>, overrides: Record<string, string> = {}) {
  return tokenRequest({ client_id: auth.client, grant_type: "authorization_code", code: auth.code, code_verifier: auth.verifier, redirect_uri: callback, resource, ...overrides });
}
interface Tokens { access_token: string; refresh_token: string; token_type: string; expires_in: number }
async function tokens(instance: "us" | "eu" = "us", client = "client-a") {
  const response = await exchange(await codeFor(instance, client));
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(JSON.stringify(body)).not.toMatch(/fixture-.*-key/);
  expect(body).toMatchObject({ token_type: "Bearer", expires_in: 600 });
  expect(body.refresh_token).toBeTruthy();
  return body as Tokens;
}
async function introspect(token: string, client = config.resourceClientId, secret = config.resourceClientSecret) {
  const form = new URLSearchParams({ token });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (secret) headers.authorization = `Basic ${Buffer.from(`${client}:${secret}`).toString("base64")}`;
  else form.set("client_id", client);
  return fetch(`${config.issuer}/token/introspection`, { method: "POST", headers, body: form });
}

beforeAll(async () => {
  databaseUrl = process.env.BROKER_TEST_DATABASE_URL || "";
  if (!databaseUrl) {
    container = `galaxy-broker-test-${randomBytes(6).toString("hex")}`;
    await exec("docker", ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD=fixture-only-password", "--env", "POSTGRES_DB=galaxy_broker_test", "postgres:17-alpine"]);
    const port = (await exec("docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1);
    databaseUrl = `postgres://postgres:fixture-only-password@127.0.0.1:${port}/galaxy_broker_test`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await exec("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); break; }
      catch { if (attempt === 49) throw new Error("Disposable PostgreSQL did not start."); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
  const target = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/galaxy_broker_test") {
    throw new Error("Broker tests require a dedicated loopback galaxy_broker_test database.");
  }
  galaxy = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const instance = path.startsWith("/us/") ? "us" : "eu";
    apiRequests.push(`${req.method} ${path} ${req.headers["x-api-key"]}`);
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET" || req.headers["x-api-key"] !== keys[instance]) { res.writeHead(401).end("{}"); return; }
    if (path.endsWith("/api/users/current")) res.end(JSON.stringify({ id: "same-id-on-two-instances", deleted: false }));
    else if (path.endsWith("/api/histories")) res.end(JSON.stringify([{ id: `history-${instance}`, name: `Private ${instance} history`, state: "ok" }]));
    else res.writeHead(404).end("{}");
  });
  galaxy.listen(0, "127.0.0.1"); await once(galaxy, "listening");
  server = createServer((req, res) => handler(req, res));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
  config = {
    issuer: address(server), resource, databaseUrl, encryptionKey: randomBytes(32), cookieKeys: [randomBytes(32).toString("hex")],
    jwks: { keys: [{ ...signingKey, kid: "fixture-signing", alg: "RS256", use: "sig" }] },
    resourceClientId: "galaxy-resource", resourceClientSecret: randomBytes(32).toString("hex"),
    clients: [
      ...["client-a", "client-b"].map((client_id): BrokerConfig["clients"][number] => ({ client_id, application_type: "native", redirect_uris: [callback], token_endpoint_auth_method: "none" })),
      { client_id: "other-confidential", client_secret: otherClientSecret, application_type: "native", redirect_uris: [callback], token_endpoint_auth_method: "client_secret_basic" },
    ],
    instances: { us: `${address(galaxy)}/us`, eu: `${address(galaxy)}/eu` }, allowLoopback: true,
  };
  broker = await createBroker(config);
  handler = broker.callback;
  database = new pg.Pool({ connectionString: databaseUrl });
}, 60000);

beforeEach(async () => { await database.query("DELETE FROM galaxy_broker_limits"); });

afterAll(async () => {
  await close(server);
  await broker?.close();
  await database?.end();
  await close(galaxy);
  if (container) await exec("docker", ["stop", container]);
}, 30000);

describe("durable Galaxy credential broker", () => {
  it("labels usegalaxy.org as US without renaming the stored main alias", async () => {
    const before = apiRequests.length;
    await broker.close();
    broker = await createBroker({ ...config, instances: { ...config.instances, main: "https://usegalaxy.org" } });
    handler = broker.callback;
    try {
      const { html } = await authorization();
      expect(html).toContain('<label for="key-main">US — https://usegalaxy.org</label>');
      expect(html).toContain('id="key-main" name="api_key.main"');
      expect(html).toContain('aria-label="API key for US"');
      expect(html).not.toContain('aria-label="API key for main"');
      expect(html).toContain(`<label for="key-us">us — ${config.instances.us}</label>`);
      expect(html).toContain('name="api_key.eu"');
      expect(apiRequests).toHaveLength(before);
    } finally {
      await broker.close();
      broker = await createBroker(config);
      handler = broker.callback;
    }
  });

  it("authorizes a bundle atomically, persists and refreshes it, and revokes it without expanding or revoking an existing grant", async () => {
    const legacy = await tokens();
    const fields = { "api_key.us": keys.us, "api_key.eu": keys.eu };
    const response = await exchange(await codeFor("us", "client-a", undefined, {}, fields));
    expect(response.status).toBe(200);
    const issued = await response.json() as Tokens;
    expect(JSON.stringify(issued)).not.toMatch(/fixture-.*-key|galaxy_connections/);
    const expected = { active: true, galaxy_connections: [
      { instance: "eu", api_key: keys.eu, url: config.instances.eu },
      { instance: "us", api_key: keys.us, url: config.instances.us },
    ] };
    const introspection = await (await introspect(issued.access_token)).json();
    expect(introspection).toMatchObject(expected);
    expect(introspection).not.toHaveProperty("galaxy_api_key");
    expect(introspection).not.toHaveProperty("galaxy_instance");
    expect(await (await introspect(issued.access_token, "client-a", "")).json()).toEqual({ active: false });
    const prior = await (await introspect(legacy.access_token)).json();
    expect(prior).toMatchObject({ active: true, galaxy_instance: "us" });
    expect(prior).not.toHaveProperty("galaxy_connections");
    expect(prior.sub).not.toBe(introspection.sub);
    const auth = await loadUniversalAuth({ metadataUrl: `${config.issuer}/.well-known/oauth-authorization-server`,
      introspectionClientId: config.resourceClientId, introspectionClientSecret: config.resourceClientSecret,
      instancesJson: JSON.stringify(config.instances), resourceServerUrl: resource });
    const mcp = await startTestService({ auth });
    try {
      await Promise.all(["us", "eu"].map(async instance => {
        const request = modernRequest("tools/call", { name: "get_histories", arguments: { instance } });
        request.headers.set("authorization", `Bearer ${issued.access_token}`);
        const response = await fetch(`${mcp.baseUrl}/mcp`, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.result.structuredContent).toMatchObject({
          galaxy: { instance, url: config.instances[instance] }, histories: [{ name: `Private ${instance} history` }],
        });
        expect(JSON.stringify(payload)).not.toMatch(/fixture-.*-key/);
      }));
      expect(mcp.logs.join(" ")).not.toContain(issued.access_token);
    } finally { await mcp.stop(); }
    await broker.close(); broker = await createBroker(config); handler = broker.callback;
    expect(await (await introspect(issued.access_token)).json()).toMatchObject(expected);
    const refreshed = await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: issued.refresh_token, resource });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as Tokens;
    expect(await (await introspect(rotated.access_token)).json()).toMatchObject(expected);
    const revoked = await fetch(`${config.issuer}/token/revocation`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "client-a", token: rotated.refresh_token }),
    });
    expect(revoked.status).toBe(200);
    expect(await (await introspect(rotated.access_token)).json()).toEqual({ active: false });
    expect((await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: rotated.refresh_token, resource })).status).toBe(400);
    expect(await (await introspect(legacy.access_token)).json()).toMatchObject({ active: true, galaxy_instance: "us" });
    const stored = await database.query<{ payload: Buffer }>("SELECT payload FROM galaxy_broker_credentials");
    expect(stored.rows.every(row => !row.payload.includes(keys.us) && !row.payload.includes(keys.eu))).toBe(true);
  });

  it("rejects empty, mixed, duplicate, unapproved and partially invalid connection sets without saving any keys", async () => {
    for (const fields of [
      {}, { "api_key.us": "", "api_key.eu": "" },
      { "api_key.us": keys.us, "api_key.eu": "wrong-key" },
      { "api_key.us": keys.us, "api_key.eu": keys.us },
      { "api_key.unknown": keys.us }, { "api_key.us": keys.us, instance: "us", api_key: keys.us },
    ]) {
      const before = (await database.query("SELECT count(*) FROM galaxy_broker_credentials")).rows[0];
      const auth = await authorization();
      expect(auth.html).toContain('name="api_key.us"');
      expect(auth.html).toContain('name="api_key.eu"');
      expect(auth.html).toContain("Choose from the 2 enabled Galaxy sites below.");
      expect(auth.html).toContain('href="http://127.0.0.1/support#request-site"');
      expect(auth.html).toContain("Request a site on GitHub");
      expect(auth.html).toContain("Never post API keys, passwords or private data.");
      expect(auth.html).toContain("every server for which I entered a key");
      const response = await auth.browser.request(auth.location, { method: "POST",
        headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: auth.csrf, consent: "yes", action: "connect", ...fields }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(keys.us);
      expect((await database.query("SELECT count(*) FROM galaxy_broker_credentials")).rows[0]).toEqual(before);
    }
    const auth = await authorization();
    const body = new URLSearchParams({ csrf: auth.csrf, consent: "yes", action: "connect", "api_key.us": keys.us });
    body.append("api_key.us", keys.us);
    expect((await auth.browser.request(auth.location, { method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" }, body })).status).toBe(400);
    const single = await exchange(await codeFor("us", "client-a", undefined, {}, { "api_key.us": keys.us, "api_key.eu": "" }));
    expect(single.status).toBe(200);
    expect(await (await introspect((await single.json()).access_token)).json()).toMatchObject({ active: true, galaxy_instance: "us" });
  });

  it("invalidates the complete bundle if any allowed site is remapped", async () => {
    const issued = await (await exchange(await codeFor("us", "client-a", undefined, {}, { "api_key.us": keys.us, "api_key.eu": keys.eu }))).json() as Tokens;
    await broker.close();
    broker = await createBroker({ ...config, instances: { ...config.instances, us: config.instances.eu! } }); handler = broker.callback;
    try { expect(await (await introspect(issued.access_token)).json()).toEqual({ active: false }); }
    finally { await broker.close(); broker = await createBroker(config); handler = broker.callback; }
  });
  it("accepts advertised OIDC scopes and issues an identity token without Galaxy credentials", async () => {
    const metadata = await (await fetch(`${config.issuer}/.well-known/oauth-authorization-server`)).json();
    const response = await exchange(await codeFor("us", "client-a", undefined, {
      scope: metadata.scopes_supported.join(" "), nonce: "fixture-oidc-nonce",
    }));
    expect(response.status).toBe(200);
    const issued = await response.json();
    const [header, payload, signature] = issued.id_token.split(".");
    const jwks = await (await fetch(metadata.jwks_uri)).json();
    expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe("RS256");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwks.keys[0], format: "jwk" }), Buffer.from(signature, "base64url"))).toBe(true);
    const identity = JSON.parse(Buffer.from(payload, "base64url").toString());
    const access = await (await introspect(issued.access_token)).json();
    expect(identity).toMatchObject({ iss: config.issuer, aud: "client-a", sub: access.sub, nonce: "fixture-oidc-nonce" });
    expect(identity.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(access).toMatchObject({ active: true, galaxy_instance: "us" });
    expect(JSON.stringify([issued, identity])).not.toMatch(/fixture-.*-key|galaxy_api_key/);
  });

  it("uses genuine OAuth discovery, PKCE login/consent and privileged introspection with the existing MCP server", async () => {
    const us = await tokens("us");
    const eu = await tokens("eu", "client-b");
    const first = await (await introspect(us.access_token)).json();
    const second = await (await introspect(eu.access_token)).json();
    expect(first).toMatchObject({ active: true, client_id: "client-a", aud: resource, galaxy_instance: "us", galaxy_api_key: keys.us, galaxy_url: config.instances.us });
    expect(second).toMatchObject({ active: true, client_id: "client-b", galaxy_instance: "eu", galaxy_api_key: keys.eu });
    expect(first.sub).not.toBe(second.sub);
    expect(await (await introspect(us.access_token, "client-a", "")).json()).toEqual({ active: false });
    expect(await (await introspect(us.access_token, "other-confidential", otherClientSecret)).json()).toEqual({ active: false });
    expect(await (await introspect(us.refresh_token)).json()).toEqual({ active: false });
    expect((await introspect(us.access_token, config.resourceClientId, "wrong-secret")).status).toBe(401);
    const auth = await loadUniversalAuth({ metadataUrl: `${config.issuer}/.well-known/oauth-authorization-server`,
      introspectionClientId: config.resourceClientId, introspectionClientSecret: config.resourceClientSecret,
      instancesJson: JSON.stringify(config.instances), resourceServerUrl: resource });
    const mcp = await startTestService({ auth });
    try {
      for (const [token, instance] of [[us.access_token, "us"], [eu.access_token, "eu"]]) {
        const request = modernRequest("tools/call", { name: "get_histories", arguments: {} });
        request.headers.set("authorization", `Bearer ${token}`);
        const response = await fetch(`${mcp.baseUrl}/mcp`, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
        expect(response.status).toBe(200);
        const output = await response.text();
        expect(output).toContain(`Private ${instance} history`);
        expect(output).not.toMatch(/fixture-.*-key/);
      }
      expect(mcp.logs.join(" ")).not.toContain(us.access_token);
      expect(mcp.logs.join(" ")).not.toContain(keys.us);
    } finally { await mcp.stop(); }
  });

  it("rejects CSRF, wrong origins, missing consent, invalid keys and unapproved instances without calling arbitrary URLs", async () => {
    for (const changes of [{ csrf: "wrong" }, { consent: "no" }, { instance: "https://attacker.test" }, { api_key: "wrong" }]) {
      const auth = await authorization();
      const response = await consent(auth, "us", changes);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(keys.us);
    }
    const auth = await authorization();
    for (const origin of ["https://attacker.test", "null", ""]) {
      expect((await auth.browser.request(auth.location, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: auth.csrf }) })).status).toBe(400);
    }
    expect((await fetch(`${config.issuer}/auth`, { headers: { host: "attacker.test" } })).status).toBe(400);
    expect((await fetch(`${config.issuer}/readyz`, { headers: { host: "127.0.0.1" } })).status).toBe(200);
    const cancellation = await authorization();
    const cancelled = await resume(cancellation, await consent(cancellation, "us", { action: "cancel" }));
    expect(cancelled.status).toBe(303);
    expect(new URL(cancelled.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    const onceOnly = await authorization();
    expect((await consent(onceOnly)).status).toBe(200);
    expect((await consent(onceOnly)).status).toBe(400);
  });

  it("binds codes to PKCE/client/resource and atomically allows only one concurrent redemption", async () => {
    for (const overrides of [{ code_verifier: "bad" }, { client_id: "client-b" }, { resource: "https://other.test/mcp" }]) {
      expect((await exchange(await codeFor(), overrides)).status).toBe(400);
    }
    const auth = await codeFor();
    const pair = await Promise.all([exchange(auth), exchange(auth)]);
    expect(pair.map(response => response.status).sort()).toEqual([200, 400]);
    const winner = await pair.find(response => response.status === 200)!.json() as Tokens;
    expect(await (await introspect(winner.access_token)).json()).toEqual({ active: false });
  });

  it("persists tokens across provider restart, revokes refresh replays, and isolates another user's grant", async () => {
    const first = await tokens();
    const other = await tokens("eu", "client-b");
    const beforeRecovery = apiRequests.length;
    // Only connections in this suite's dedicated fixture database are interrupted.
    const interrupted = await database.query<{ pg_terminate_backend: boolean }>("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
    expect(interrupted.rows.some(row => row.pg_terminate_backend)).toBe(true);
    await expect.poll(async () => (await fetch(`${config.issuer}/readyz`)).status).toBe(200);
    expect(await (await introspect(first.access_token)).json()).toMatchObject({ active: true });
    expect(apiRequests).toHaveLength(beforeRecovery);
    await broker.close(); broker = await createBroker(config); handler = broker.callback;
    expect(await (await introspect(first.access_token)).json()).toMatchObject({ active: true, galaxy_api_key: keys.us });
    const refresh = () => tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: first.refresh_token, resource });
    const refreshed = await refresh();
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as Tokens;
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expect((await refresh()).status).toBe(400);
    expect(await (await introspect(rotated.access_token)).json()).toEqual({ active: false });
    expect(await (await introspect(other.access_token)).json()).toMatchObject({ active: true, galaxy_api_key: keys.eu });
    const revoked = await fetch(`${config.issuer}/token/revocation`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: "client-b", token: other.access_token }) });
    expect(revoked.status).toBe(200);
    expect(await (await introspect(other.access_token)).json()).toEqual({ active: false });
    expect((await tokenRequest({ client_id: "client-b", grant_type: "refresh_token", refresh_token: other.refresh_token })).status).toBe(400);
  });

  it("invalidates an old credential when an instance alias is remapped", async () => {
    const before = await tokens();
    await broker.close();
    broker = await createBroker({ ...config, instances: { ...config.instances, us: config.instances.eu! } }); handler = broker.callback;
    expect(await (await introspect(before.access_token)).json()).toEqual({ active: false });
    await broker.close(); broker = await createBroker(config); handler = broker.callback;
  });

  it("allows only one simultaneous refresh and revokes its chain after replay", async () => {
    const original = await tokens();
    const request = () => tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: original.refresh_token, resource });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    const winner = await responses.find(response => response.status === 200)!.json() as Tokens;
    expect(await (await introspect(winner.access_token)).json()).toEqual({ active: false });
    expect((await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: winner.refresh_token })).status).toBe(400);
  });

  it("keeps an explicitly consented galaxy:full-only connection usable after browser session loss", async () => {
    const response = await exchange(await codeFor("us", "client-a", undefined, { scope: "galaxy:full" }));
    expect(response.status).toBe(200);
    const issued = await response.json() as Tokens;
    expect(issued.refresh_token).toBeTruthy();
    await database.query("DELETE FROM galaxy_broker_models WHERE model='Session'");
    expect(await (await introspect(issued.access_token)).json()).toMatchObject({ active: true });
    const refreshed = await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: issued.refresh_token, resource });
    expect(refreshed.status).toBe(200);
  });

  it("rejects expired access-token storage and preserves a valid refresh grant", async () => {
    const issued = await tokens();
    const storedToken = await broker.provider.AccessToken.find(issued.access_token);
    const grant = await broker.provider.Grant.find(storedToken!.grantId!);
    expect(grant!.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    expect(grant!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 24 * 60 * 60);
    expect((await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: issued.refresh_token, resource, scope: "galaxy:full admin" })).status).toBe(400);
    await database.query("UPDATE galaxy_broker_models SET expires_at=0 WHERE model='AccessToken'");
    expect(await (await introspect(issued.access_token)).json()).toEqual({ active: false });
    const refreshed = await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: issued.refresh_token, resource });
    expect(refreshed.status).toBe(200);
    const current = await refreshed.json() as Tokens;
    expect(await (await introspect(current.access_token)).json()).toMatchObject({ active: true });
    await database.query("UPDATE galaxy_broker_models SET expires_at=0 WHERE model='Grant'");
    expect(await (await introspect(current.access_token)).json()).toEqual({ active: false });
    expect((await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: current.refresh_token, resource })).status).toBe(400);
  });

  it("enforces the persisted interaction rate limit", async () => {
    const auth = await authorization();
    for (let attempt = 0; attempt < 29; attempt++) {
      expect((await auth.browser.request(auth.location)).status).toBe(200);
    }
    expect((await auth.browser.request(auth.location)).status).toBe(429);
  });

  it("supports library form_post responses and changing Galaxy account in the same browser", async () => {
    const browser = new Browser();
    const first = await exchange(await codeFor("us", "client-a", browser));
    expect(first.status).toBe(200);
    const changed = await exchange(await codeFor("eu", "client-a", browser));
    expect(changed.status).toBe(200);
    const changedTokens = await changed.json() as Tokens;
    expect(await (await introspect(changedTokens.access_token)).json()).toMatchObject({ active: true, galaxy_instance: "eu" });
    const auth = await authorization("client-a", { response_mode: "form_post" });
    const post = await resume(auth, await consent(auth));
    expect(post.status).toBe(200);
    const html = await post.text();
    expect(html).toContain(callback);
    expect(html).toContain('name="code"');
    expect(html).toContain("<script");
    expect(post.headers.get("content-security-policy") || "").not.toContain("default-src 'none'");
    expect(html).not.toMatch(/fixture-.*-key/);
  });

  it("persists encrypted credentials and consumed state, with immutable and authenticated bindings", async () => {
    const store = await createStore(databaseUrl, config.encryptionKey);
    try {
      const adapter = new store.adapter("AuthorizationCode");
      const id = randomBytes(16).toString("hex");
      const single = `${id}-single`;
      await adapter.upsert(single, {}, 60);
      await adapter.consume(single);
      expect((await adapter.find(single))?.consumed).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
      expect((await adapter.find(single))?.consumed).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      await adapter.upsert(id, { grantId: id }, 60);
      const consumed = await Promise.allSettled([adapter.consume(id), adapter.consume(id)]);
      expect(consumed.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(consumed.filter(result => result.status === "rejected")).toHaveLength(1);
      await store.saveCredential(id, { accountId: `fixture-${id}`, clientId: "client-a", instance: "us", audience: resource, apiKey: keys.us, baseUrl: config.instances.us! }, Date.now() + 60000);
      await expect(store.saveCredential(id, { accountId: "other", clientId: "client-a", instance: "eu", audience: resource, apiKey: keys.eu, baseUrl: config.instances.eu! }, Date.now() + 60000)).rejects.toThrow();
      expect(await store.credential(id)).toMatchObject({ apiKey: keys.us, instance: "us" });
      const encrypted = await database.query<{ grant_id: string; payload: Buffer }>("SELECT grant_id,payload FROM galaxy_broker_credentials WHERE account_id=$1", [`fixture-${id}`]);
      expect(encrypted.rows).toHaveLength(1);
      const stored = encrypted.rows[0]!;
      expect(stored.payload.includes(Buffer.from(keys.us))).toBe(false);
      expect(stored.payload.includes(Buffer.from(config.instances.us!))).toBe(false);
      const models = await database.query<{ payload: Buffer }>("SELECT payload FROM galaxy_broker_models");
      expect(models.rows.every(row => !row.payload.includes(Buffer.from(keys.us)))).toBe(true);
      await database.query("UPDATE galaxy_broker_credentials SET instance='eu' WHERE grant_id=$1", [stored.grant_id]);
      await expect(store.credential(id)).rejects.toThrow();
      await database.query("UPDATE galaxy_broker_credentials SET instance='us',payload=$2 WHERE grant_id=$1", [stored.grant_id, Buffer.alloc(stored.payload.length)]);
      await expect(store.credential(id)).rejects.toThrow();
      const wrongKey = await createStore(databaseUrl, randomBytes(32));
      try { expect(await wrongKey.credential(id)).toBeUndefined(); } finally { await wrongKey.close(); }
      await adapter.revokeByGrantId(id);
      expect(await store.credential(id)).toBeUndefined();
    } finally { await store.close(); }
    expect(apiRequests.every(request => request.startsWith("GET "))).toBe(true);
  });
});
