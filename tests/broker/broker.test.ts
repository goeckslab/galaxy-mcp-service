import { execFile } from "node:child_process";
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createBroker, type BrokerConfig } from "../../apps/broker/src/broker.js";
import { createStore } from "../../apps/broker/src/store.js";
import { loadUniversalAuth } from "../../apps/service/src/auth.js";
import { modernRequest, startTestService } from "../helpers/service.js";
import { eventLease, type SubscribeParams } from "../../packages/protocol/src/events.js";
import { processRunEvent } from "../../apps/service/src/events.js";

const exec = promisify(execFile);
const resource = "http://127.0.0.1/mcp";
const callback = "http://127.0.0.1/callback";
const keys = { us: "fixture-alice-us-key", eu: "fixture-bob-eu-key" };
const otherClientSecret = "fixture-other-confidential-client-secret";
const apiRequests: string[] = [];
// Access tokens a signed-in site accepts, mapped to the Galaxy account; null is a sign-in Galaxy has not linked yet.
const bearerUsers = new Map<string, string | null>();
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

async function authorization(client = "client-a", overrides: Record<string, string | undefined> = {}, browser = new Browser()) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: client, redirect_uri: callback, response_type: "code", scope: "galaxy:full offline_access",
    resource, state: "fixture-state", code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(name);
    else params.set(name, value);
  }
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

/**
 * The fields a person sends by ticking sites: "api_key.<site>" with a key ticks that site and uses the key,
 * "login.<site>" ticks it and chooses to sign in. Other fields pass through unchanged.
 */
function ticked(fields: Record<string, string>) {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name.startsWith("login.")) { result[`site.${name.slice(6)}`] = "yes"; result[`method.${name.slice(6)}`] = "login"; continue; }
    result[name] = value;
    if (name.startsWith("api_key.") && value) { result[`site.${name.slice(8)}`] = "yes"; result[`method.${name.slice(8)}`] = "key"; }
  }
  return result;
}

async function consent(auth: Awaited<ReturnType<typeof authorization>>, instance: "us" | "eu" = "us", changes: Record<string, string> = {}) {
  return auth.browser.request(auth.location, {
    method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(ticked({ csrf: auth.csrf, [`api_key.${instance}`]: keys[instance], consent: "yes", action: "connect", ...changes })),
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

async function codeFor(instance: "us" | "eu" = "us", client = "client-a", browser?: Browser, parameters: Record<string, string | undefined> = {}, connectionFields?: Record<string, string>) {
  const auth = await authorization(client, parameters, browser);
  let response = await resume(auth, await (connectionFields ? auth.browser.request(auth.location, {
    method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(ticked({ csrf: auth.csrf, consent: "yes", action: "connect", ...connectionFields })),
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
      expect(location.origin + location.pathname).toBe(parameters.redirect_uri || callback);
      expect(location.searchParams.get("state")).toBe("fixture-state");
      expect(location.searchParams.get("iss")).toBe(config.issuer);
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
interface Tokens { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope?: string }
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

async function managementLink(token: string) {
  return fetch(`${config.issuer}/management/ticket`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${config.resourceClientId}:${config.resourceClientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });
}

/** Opens the management page for an access token's grant and returns its HTML. */
async function managementPage(token: string, browser = new Browser()) {
  const link = await (await managementLink(token)).json() as { url: string };
  const ticket = /name="ticket" value="([^"]+)"/.exec(await (await browser.request(link.url)).text())![1]!;
  const page = await browser.request(`${config.issuer}/connections/start`, {
    method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket }),
  });
  expect(page.status).toBe(200);
  return page.text();
}

/** The one-time token of the form whose button reads `text`. */
function buttonToken(html: string, text: string) {
  return new RegExp(`name="action_token" value="([^"]+)"><button[^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</button>`).exec(html)?.[1];
}

async function managementPost(path: "action" | "save", fields: Record<string, string>, browser = new Browser()) {
  return browser.request(`${config.issuer}/connections/${path}`, {
    method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(ticked(fields)),
  });
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
    if (path.startsWith("/signin/")) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      apiRequests.push(`${req.method} ${path} bearer:${token} key:${req.headers["x-api-key"] ?? ""}`);
      res.setHeader("content-type", "application/json");
      const user = bearerUsers.get(token);
      if (user === null) { res.writeHead(401).end(JSON.stringify({ err_msg: "Cannot locate user by access token. The user should log into Galaxy at least once with this OIDC provider." })); return; }
      if (!user || req.headers["x-api-key"]) { res.writeHead(401).end(JSON.stringify({ err_msg: "Invalid access token." })); return; }
      if (path.endsWith("/api/users/current")) res.end(JSON.stringify({ id: user, deleted: false }));
      else if (path.endsWith("/api/histories")) res.end(JSON.stringify([{ id: "history-test", name: "Signed-in test history", state: "ok" }]));
      else res.writeHead(404).end("{}");
      return;
    }
    const instance = path.startsWith("/us/") ? "us" : "eu";
    apiRequests.push(`${req.method} ${path} ${req.headers["x-api-key"]}`);
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET" || req.headers["x-api-key"] !== keys[instance]) { res.writeHead(401).end("{}"); return; }
    if (path.endsWith("/api/users/current")) res.end(JSON.stringify({ id: "same-id-on-two-instances", deleted: false }));
    else if (path.endsWith("/api/histories")) res.end(JSON.stringify([{ id: `history-${instance}`, name: `Private ${instance} history`, state: "ok" }]));
    else if (path.endsWith("/api/invocations/run-1/jobs_summary")) res.end(JSON.stringify({ states: { ok: 1 }, populated_state: "ok" }));
    else if (path.endsWith("/api/invocations/run-1")) res.end(JSON.stringify({ id: "run-1", state: "scheduled", history_id: `history-${instance}` }));
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
  it.each([
    ["https://chatgpt.com/oauth/codex/client.json", ["http://127.0.0.1:43111/callback", "http://localhost:43112/callback"]],
    ["https://claude.ai/oauth/claude-code-client-metadata", ["http://localhost:43113/callback", "http://127.0.0.1:43114/callback"]],
    ["https://vscode.dev/oauth/client-metadata.json", ["http://127.0.0.1:43115/", "https://vscode.dev/redirect"]],
    ["galaxy-cursor", ["http://localhost:8787/callback", "https://www.cursor.com/agents/mcp/oauth/callback"]],
    ["galaxy-gemini-cli", ["http://localhost:43116/oauth/callback", "http://localhost:43117/oauth/callback"]],
    ["galaxy-grok-build", ["http://localhost:3120/callback", "http://127.0.0.1:43118/callback"]],
    ["https://grok.com/oauth/mcp-client.json", ["https://grok.com/connectors-oauth-exchange-code/", "https://console.x.ai/connectors-oauth-exchange-code/"]],
  ] as const)("authorizes the curated %s profile with issuer-bound callbacks, PKCE and isolated rotating refresh", async (clientId, callbacks) => {
    const client = await broker.provider.Client.find(clientId);
    expect(client?.applicationType).toBe(clientId === "https://grok.com/oauth/mcp-client.json" ? "web" : "native");
    for (const redirect of ["https://attacker.example/callback", "http://localhost.attacker.example/callback",
      "http://127.0.0.2/callback", "http://localhost/callback/extra", "http://localhost/oauth/callback?next=evil",
      "https://grok.com/connectors-oauth-exchange-code", "https://grok.com:444/connectors-oauth-exchange-code/",
      "https://console.x.ai/connectors-oauth-exchange-code/?next=evil"]) {
      expect(client?.redirectUriAllowed(redirect)).toBe(false);
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
        scope: "galaxy:full", resource, code_challenge_method: "S256", code_challenge: "fixture-challenge" });
      const rejected = await fetch(`${config.issuer}/auth?${params}`, { redirect: "manual" });
      expect(rejected.headers.get("location")).toBeNull();
      expect(rejected.status).toBe(400);
    }
    for (const redirect_uri of callbacks) {
      const issued = await codeFor("us", clientId, undefined, { redirect_uri });
      const response = await exchange(issued, { redirect_uri });
      expect(response.status).toBe(200);
      const body = await response.json() as Tokens;
      expect(body.refresh_token).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain(keys.us);
      expect(await (await introspect(body.access_token)).json()).toMatchObject({ active: true, client_id: clientId,
        galaxy_connections: [{ instance: "us", api_key: keys.us }] });
      const refreshed = await tokenRequest({ client_id: clientId, grant_type: "refresh_token", refresh_token: body.refresh_token, resource });
      expect(refreshed.status).toBe(200);
      const rotated = await refreshed.json() as Tokens;
      expect(rotated.refresh_token).not.toBe(body.refresh_token);
      expect((await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: rotated.refresh_token, resource })).status).toBe(400);
    }
  });

  it("uses Claude's published identity without registration while retaining consent, PKCE, refresh and metadata boundaries", async () => {
    const callbackUri = "https://claude.ai/api/mcp/auth_callback";
    const clientId = `https://claude.ai/oauth/fixture-${randomBytes(6).toString("hex")}`;
    const metadata = { client_id: clientId, client_name: "Untrusted display name", redirect_uris: [callbackUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    const documents = new Map<string, object>([[clientId, metadata]]);
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(config.issuer) && !url.startsWith(address(galaxy))) {
        fetched.push(url);
        expect(init?.redirect).toBe("manual");
        expect(init?.signal).toBeTruthy();
        if (!documents.has(url)) throw new Error("Unexpected metadata fetch.");
        return Response.json(documents.get(url), { headers: { "cache-control": "max-age=60" } });
      }
      return originalFetch(input, init);
    });
    try {
      const discovery = await (await fetch(`${config.issuer}/.well-known/oauth-authorization-server`)).json();
      expect(discovery.client_id_metadata_document_supported).toBe(true);
      expect(discovery.token_endpoint_auth_methods_supported).toContain("none");
      expect(discovery.registration_endpoint).toBeUndefined();
      expect(discovery.authorization_response_iss_parameter_supported).toBe(true);
      const issued = await codeFor("us", clientId, undefined, { redirect_uri: callbackUri });
      expect(issued.html).toContain("<strong>claude.ai</strong>");
      expect(issued.html).not.toContain(metadata.client_name);
      expect(fetched).toEqual([clientId]);
      expect((await exchange(issued, { redirect_uri: callbackUri, code_verifier: "wrong-verifier" })).status).toBe(400);
      // A rejected exchange may consume its code, so use a fresh explicitly consented grant.
      const response = await exchange(await codeFor("us", clientId, undefined, { redirect_uri: callbackUri }), { redirect_uri: callbackUri });
      const body = await response.json() as Tokens;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ token_type: "Bearer", expires_in: 600 });
      expect(JSON.stringify(body)).not.toContain(keys.us);
      expect(await (await introspect(body.access_token)).json()).toMatchObject({ active: true, client_id: clientId,
        galaxy_connections: [{ instance: "us", api_key: keys.us }] });
      const refreshed = await tokenRequest({ client_id: clientId, grant_type: "refresh_token", refresh_token: body.refresh_token, resource });
      const rotated = await refreshed.json() as Tokens;
      expect(refreshed.status).toBe(200);
      expect(rotated.refresh_token).not.toBe(body.refresh_token);
      expect(await (await introspect(rotated.access_token)).json()).toMatchObject({ active: true, client_id: clientId });
      const link = await (await managementLink(rotated.access_token)).json() as { url: string };
      const browser = new Browser();
      const ticket = /name="ticket" value="([^"]+)"/.exec(await (await browser.request(link.url)).text())?.[1];
      const managed = await (await browser.request(`${config.issuer}/connections/start`, {
        method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ticket: ticket! }),
      })).text();
      expect(managed).toContain("<h2>claude.ai</h2>");
      expect(managed).not.toContain(clientId);
      expect((await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: rotated.refresh_token, resource })).status).toBe(400);

      for (const overrides of [{ redirect_uri: "https://attacker.example/callback" }, { code_challenge_method: "plain" }]) {
        const params = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUri, response_type: "code", scope: "galaxy:full",
          resource, code_challenge: createHash("sha256").update("fixture-verifier").digest("base64url"), code_challenge_method: "S256", ...overrides });
        const rejected = await fetch(`${config.issuer}/auth?${params}`, { redirect: "manual" });
        expect(rejected.headers.get("location") || "").not.toContain("/interaction/");
        expect(rejected.headers.get("location") || "").not.toContain("attacker.example");
      }
      const before = fetched.length;
      for (const id of ["https://attacker.example/oauth/metadata", "https://claude.ai.attacker.example/oauth/metadata",
        "http://claude.ai/oauth/metadata", "https://claude.ai/oauth/metadata?redirect=evil", "https://claude.ai/profile/metadata"])
        await expect(broker.provider.Client.find(id).catch(() => undefined)).resolves.toBeUndefined();
      expect(fetched).toHaveLength(before);
      for (const changes of [{ client_id: "https://attacker.example/wrong" }, { client_secret: "forbidden" },
        { token_endpoint_auth_method: "private_key_jwt", jwks: config.jwks }, { redirect_uris: ["https://attacker.example/callback"] }]) {
        const id = `https://claude.ai/oauth/fixture-${randomBytes(6).toString("hex")}`;
        documents.set(id, { ...metadata, client_id: id, ...changes });
        await expect(broker.provider.Client.find(id)).rejects.toThrow();
      }
    } finally { fetchMock.mockRestore(); }
  });

  it("persists grant-bound run events, leases concurrent workers, rotates secrets, and stops on removal or revocation", async () => {
    const issuedResponse = await exchange(await codeFor("us", "client-a", undefined, {}, { "api_key.us": keys.us, "api_key.eu": keys.eu }));
    let issued = await issuedResponse.json() as Tokens;
    const other = await tokens("us", "client-a"); // Same account/client, different exact grant.
    const auth = await loadUniversalAuth({ metadataUrl: `${config.issuer}/.well-known/oauth-authorization-server`,
      introspectionClientId: config.resourceClientId, introspectionClientSecret: config.resourceClientSecret,
      instancesJson: JSON.stringify(config.instances), resourceServerUrl: resource });
    const backend = auth.eventRequest!;
    const params: SubscribeParams = { name: "galaxy.run.outcome", arguments: { instance: "us", kind: "workflow", runId: "run-1" },
      delivery: { mode: "webhook", url: "https://callback.example.test/run-1", secret: "whsec_" + randomBytes(32).toString("base64") } };
    const prepared = await backend("prepare", { token: issued.access_token, params }) as { id: string; verification_required: boolean };
    expect(prepared.verification_required).toBe(true);
    const subscribe = (token: string, value = params) => backend("subscribe", { token, params: value, verified_at: Date.now() }) as Promise<{ id: string; refreshBefore: string }>;
    const first = await subscribe(issued.access_token);
    expect(first.id).toBe(prepared.id);
    expect(Date.parse(first.refreshBefore)).toBeLessThanOrEqual(Date.now() + 86400000);
    expect(await backend("prepare", { token: issued.access_token, params })).toMatchObject({ verification_required: false });
    expect((await subscribe(other.access_token)).id).not.toBe(first.id);
    await backend("unsubscribe", { token: other.access_token, params: { ...params, delivery: { mode: "webhook", url: params.delivery.url } } });
    expect((await subscribe(issued.access_token, { ...params, arguments: { runId: "run-1", kind: "workflow", instance: "us" } })).id).toBe(first.id);
    const encrypted = await database.query<{ payload: Buffer }>("SELECT payload FROM galaxy_broker_events WHERE id=$1", [first.id]);
    expect(encrypted.rows[0]!.payload.toString()).not.toContain(params.delivery.secret);
    expect(encrypted.rows[0]!.payload.toString()).not.toContain("callback.example.test");
    await broker.close(); broker = await createBroker(config); handler = broker.callback;
    const claims = await Promise.all([backend("claim", {}), backend("claim", {})]) as { item: unknown }[];
    expect(claims.filter(value => value.item)).toHaveLength(1);
    const item = eventLease.parse(claims.find(value => value.item)!.item);
    const rotated = { ...params, delivery: { ...params.delivery, secret: "whsec_" + randomBytes(32).toString("base64") } };
    expect(await backend("prepare", { token: issued.access_token, params: rotated })).toMatchObject({ verification_required: true });
    expect((await subscribe(issued.access_token, rotated)).id).toBe(first.id);
    expect(await backend("save", { id: first.id, revision: item.revision, lease: item.lease, state: { phase: "delivered", attempts: 0 }, delay_ms: 0, release: true })).toEqual({ saved: null });
    let deliveredId: string | undefined;
    await processRunEvent(backend, new AbortController().signal, async (subscription, id) => {
      expect(subscription.delivery.secret).toBe(rotated.delivery.secret);
      expect(subscription.previousSecret).toBe(params.delivery.secret);
      deliveredId = id;
      return { status: 503, text: "" };
    });
    expect(deliveredId).toBeTruthy();
    const tokenId = createHmac("sha256", config.encryptionKey).update(`AccessToken:${issued.access_token}`).digest("hex");
    await database.query("UPDATE galaxy_broker_models SET expires_at=0 WHERE model='AccessToken' AND id=$1", [tokenId]);
    expect(await (await introspect(issued.access_token)).json()).toEqual({ active: false });
    await broker.close(); broker = await createBroker(config); handler = broker.callback;
    await database.query("UPDATE galaxy_broker_events SET next_at=0 WHERE id=$1", [first.id]);
    await processRunEvent(backend, new AbortController().signal, async (_subscription, id) => {
      expect(id).toBe(deliveredId); return { status: 200, text: "" };
    });
    const refreshed = await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: issued.refresh_token, resource });
    expect(refreshed.status).toBe(200);
    issued = await refreshed.json() as Tokens;
    await subscribe(issued.access_token, rotated);
    expect(await backend("claim", {})).toEqual({ item: null }); // Renewal does not repeat an acknowledged outcome.
    const euParams = { ...rotated, arguments: { ...rotated.arguments, instance: "eu" } };
    const euSub = await subscribe(issued.access_token, euParams);
    const credential = await broker.provider.AccessToken.find(issued.access_token);
    const store = await createStore(databaseUrl, config.encryptionKey);
    try {
      const managed = await store.managedCredential(credential!.accountId!, credential!.grantId!);
      await store.removeConnection(credential!.accountId!, managed!.grantId, "eu");
      expect((await database.query("SELECT id FROM galaxy_broker_events WHERE id=$1", [euSub.id])).rowCount).toBe(0);
      await expect(subscribe(issued.access_token, euParams)).rejects.toThrow();
      const pending = await subscribe(issued.access_token, { ...rotated, delivery: { ...rotated.delivery, url: "https://callback.example.test/another" } });
      await store.revokeCredential(credential!.accountId!, managed!.grantId);
      expect((await database.query("SELECT id FROM galaxy_broker_events WHERE id=$1", [pending.id])).rowCount).toBe(0);
      expect(await backend("claim", {})).toEqual({ item: null });
      expect(await (await introspect(other.access_token)).json()).toMatchObject({ active: true });
    } finally { await store.close(); }
  });

  it("uses only the us alias for usegalaxy.org authorization", async () => {
    const before = apiRequests.length;
    await broker.close();
    broker = await createBroker({ ...config, instances: { ...config.instances, us: "https://usegalaxy.org" } });
    handler = broker.callback;
    try {
      const { html } = await authorization();
      expect(html).toContain('<input type="checkbox" name="site.us" value="yes"><span class="name">Galaxy US</span><span class="host">usegalaxy.org</span>');
      expect(html).toContain('id="key-us" name="api_key.us"');
      expect(html).toContain('aria-label="API key for Galaxy US"');
      expect(html).toContain('href="https://usegalaxy.org/user/api_key"');
      expect(html).not.toContain('api_key.main');
      expect(html).toContain('name="api_key.eu"');
      expect(apiRequests).toHaveLength(before);
    } finally {
      await broker.close();
      broker = await createBroker(config);
      handler = broker.callback;
    }
  });

  it("authorizes a bundle atomically, persists and refreshes it, and revokes it without expanding or revoking an existing grant", async () => {
    const priorToken = await tokens();
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
    const prior = await (await introspect(priorToken.access_token)).json();
    expect(prior).toMatchObject({ active: true, galaxy_connections: [{ instance: "us", api_key: keys.us, url: config.instances.us }] });
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
    expect(await (await introspect(priorToken.access_token)).json()).toMatchObject({ active: true, galaxy_connections: [{ instance: "us" }] });
    const stored = await database.query<{ payload: Buffer }>("SELECT payload FROM galaxy_broker_credentials");
    expect(stored.rows.every(row => !row.payload.includes(keys.us) && !row.payload.includes(keys.eu))).toBe(true);
  });

  it("manages the active plugin grant without cookies, exposing keys or changing another grant", async () => {
    const connected = await codeFor("us", "client-a", undefined, {}, { "api_key.us": keys.us, "api_key.eu": keys.eu });
    const issuedResponse = await exchange(connected);
    expect(issuedResponse.status).toBe(200);
    const issued = await issuedResponse.json() as Tokens;
    const other = await tokens("us", "client-b");
    const unrelated = await tokens("eu", "client-a");

    const denied = await managementLink("inactive-token");
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toMatch(/fixture-.*-key/);
    const linkResponse = await managementLink(issued.access_token);
    expect(linkResponse.status).toBe(200);
    const link = await linkResponse.json() as { url: string; expires_in: number };
    expect(link).toMatchObject({ expires_in: 300 });
    expect(link.url).toMatch(new RegExp(`^${config.issuer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/connections/[A-Za-z0-9_-]+$`));
    expect(link.url).not.toMatch(/fixture-.*-key/);

    const browser = new Browser();
    expect((await browser.request(`${config.issuer}/connections`)).status).toBe(200);
    const landing = await browser.request(link.url);
    expect(landing.status).toBe(200);
    expect(landing.headers.get("referrer-policy")).toBe("same-origin");
    expect(browser.cookies.size).toBe(0);
    const landingHtml = await landing.text();
    const ticket = /name="ticket" value="([^"]+)"/.exec(landingHtml)?.[1];
    expect(ticket).toBeTruthy();
    const page = await browser.request(`${config.issuer}/connections/start`, {
      method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: ticket! }),
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const html = await page.text();
    expect(html).toContain("Manage connections");
    expect(html).toContain(config.instances.us);
    expect(html).toContain(config.instances.eu);
    expect(html).toContain("Can browse Galaxy data and run analyses");
    expect(html).not.toMatch(/fixture-.*-key|grant_id|account_id/);
    expect(browser.cookies.size).toBe(0);
    expect((await browser.request(`${config.issuer}/connections/start`, {
      method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: ticket! }),
    })).status).toBe(400);
    const remove = /<strong>us<\/strong>[\s\S]*?name="action_token" value="([^"]+)"><button class="secondary">Remove site/.exec(html)?.[1];
    expect(remove).toBeTruthy();

    const forged = await browser.request(`${config.issuer}/connections/action`, {
      method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action_token: remove! }),
    });
    expect(forged.status).toBe(400);
    expect(await (await introspect(issued.access_token)).json()).toMatchObject({
      active: true, galaxy_connections: [{ instance: "eu" }, { instance: "us" }],
    });

    const removed = await browser.request(`${config.issuer}/connections/action`, {
      method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action_token: remove! }),
    });
    expect(removed.status).toBe(200);
    expect(await (await introspect(issued.access_token)).json()).toMatchObject({
      active: true, galaxy_connections: [{ instance: "eu", api_key: keys.eu }],
    });
    expect((await browser.request(`${config.issuer}/connections/action`, {
      method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action_token: remove! }),
    })).status).toBe(400);
    const removedHtml = await removed.text();
    expect(removedHtml).not.toContain(config.instances.us);
    const revoke = /name="action_token" value="([^"]+)"><button class="danger">Disconnect this client/.exec(removedHtml)?.[1];
    expect(revoke).toBeTruthy();
    const revoked = await browser.request(`${config.issuer}/connections/action`, {
      method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action_token: revoke! }),
    });
    expect(revoked.status).toBe(200);
    expect(await (await introspect(issued.access_token)).json()).toEqual({ active: false });
    expect(await (await introspect(other.access_token)).json()).toMatchObject({ active: true });
    expect(await (await introspect(unrelated.access_token)).json()).toMatchObject({ active: true });
  });

  it("adds a site to an existing grant and switches a site's key from the management page, verifying and confirming each change", async () => {
    const issued = await tokens("us");
    const other = await tokens("us", "client-b");
    const page = await managementPage(issued.access_token);
    expect(page).toContain('<span class="status">API key</span>');
    expect(page).not.toContain(config.instances.eu);

    // Adding offers only the sites not yet in this connection.
    const adding = await managementPost("action", { action_token: buttonToken(page, "Add a Galaxy site")! });
    expect(adding.status).toBe(200);
    const addForm = await adding.text();
    expect(addForm).toContain('name="api_key.eu"');
    expect(addForm).not.toContain('name="api_key.us"');
    expect(addForm).toContain("I allow client-a to read my Galaxy data");
    const save = /action="\/connections\/save"><input type="hidden" name="action_token" value="([^"]+)"/.exec(addForm)![1]!;

    // A key Galaxy refuses saves nothing and offers a way back.
    const refused = await managementPost("save", { action_token: save, consent: "yes", "api_key.eu": "wrong-key" });
    expect(refused.status).toBe(400);
    const refusal = await refused.text();
    expect(refusal).toContain("API key not accepted");
    expect(refusal).not.toContain("wrong-key");
    expect(await (await introspect(issued.access_token)).json()).toMatchObject({ galaxy_connections: [{ instance: "us" }] });
    // The save token was used; the page's own back button opens a fresh form for the same change.
    expect((await managementPost("save", { action_token: save, consent: "yes", "api_key.eu": keys.eu })).status).toBe(400);
    const retry = await (await managementPost("action", { action_token: buttonToken(refusal, "Back to Manage connections")! })).text();
    const retrySave = /action="\/connections\/save"><input type="hidden" name="action_token" value="([^"]+)"/.exec(retry)![1]!;
    // A site the form did not offer cannot be slipped in.
    expect((await managementPost("save", { action_token: retrySave, consent: "yes", "api_key.us": keys.us })).status).toBe(400);

    const again = await managementPost("action", { action_token: buttonToken(await managementPage(issued.access_token), "Add a Galaxy site")! });
    const addSave = /action="\/connections\/save"><input type="hidden" name="action_token" value="([^"]+)"/.exec(await again.text())![1]!;
    const added = await managementPost("save", { action_token: addSave, consent: "yes", "api_key.eu": keys.eu });
    expect(added.status).toBe(200);
    const addedPage = await added.text();
    expect(addedPage).toContain("eu updated.");
    expect(addedPage).not.toContain("Add a Galaxy site");
    expect(await (await introspect(issued.access_token)).json()).toMatchObject({ active: true, galaxy_connections: [
      { instance: "eu", api_key: keys.eu }, { instance: "us", api_key: keys.us },
    ] });
    // Another client's grant for the same account is untouched.
    expect(await (await introspect(other.access_token)).json()).toMatchObject({ galaxy_connections: [{ instance: "us" }] });
    expect((await (await introspect(other.access_token)).json()).galaxy_connections).toHaveLength(1);

    // Changing one site offers only that site and needs consent again.
    const changing = await managementPost("action", { action_token: /<strong>us<\/strong>[\s\S]*?name="action_token" value="([^"]+)"><button class="secondary">Change/.exec(addedPage)![1]! });
    const changeForm = await changing.text();
    expect(changeForm).toContain("<h1>Change us</h1>");
    expect(changeForm).toContain('<span class="status">Now: API key</span>');
    expect(changeForm).not.toContain('name="api_key.eu"');
    const changeSave = /action="\/connections\/save"><input type="hidden" name="action_token" value="([^"]+)"/.exec(changeForm)![1]!;
    const unconfirmed = await managementPost("save", { action_token: changeSave, "api_key.us": keys.us });
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.text()).toContain("Nothing was changed");
  });

  it("rejects empty, obsolete, duplicate, unapproved and partially invalid connection sets without saving any keys", async () => {
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
      expect(auth.html).toContain("Tick the Galaxy sites to connect.");
      expect(auth.html).toContain('href="http://127.0.0.1/support#request-site"');
      expect(auth.html).toContain("Request a site on GitHub");
      expect(auth.html).toContain("Never post API keys, passwords or private data.");
      expect(auth.html).toContain("I allow client-a to read my Galaxy data and run analyses on the sites I ticked.");
      expect(auth.html).toContain("to add or remove a site, switch accounts, replace a key or disconnect");
      const response = await auth.browser.request(auth.location, { method: "POST",
        headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(ticked({ csrf: auth.csrf, consent: "yes", action: "connect", ...fields })),
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
    expect(await (await introspect((await single.json()).access_token)).json()).toMatchObject({ active: true, galaxy_connections: [{ instance: "us", api_key: keys.us }] });
  });

  it("connects only the ticked sites, ignoring a key left in a site that was unticked", async () => {
    const auth = await authorization();
    const response = await resume(auth, await auth.browser.request(auth.location, {
      method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: auth.csrf, consent: "yes", action: "connect", "site.us": "yes", "api_key.us": `  ${keys.us}  `, "api_key.eu": "typed-then-unticked" }),
    }));
    let next = response;
    while (next.status === 303 && new URL(next.headers.get("location")!, config.issuer).origin === config.issuer) {
      next = await auth.browser.request(new URL(next.headers.get("location")!, config.issuer).href);
    }
    const issued = await (await exchange({ ...auth, code: new URL(next.headers.get("location")!).searchParams.get("code")! })).json() as Tokens;
    expect((await (await introspect(issued.access_token)).json()).galaxy_connections).toEqual([{ instance: "us", api_key: keys.us, url: config.instances.us }]);
    expect(apiRequests.join(" ")).not.toContain("typed-then-unticked");
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
    expect(access).toMatchObject({ active: true, galaxy_connections: [{ instance: "us" }] });
    expect(JSON.stringify([issued, identity])).not.toMatch(/fixture-.*-key|galaxy_api_key/);
  });

  it("uses genuine OAuth discovery, PKCE login/consent and privileged introspection with the existing MCP server", async () => {
    const us = await tokens("us");
    const eu = await tokens("eu", "client-b");
    const first = await (await introspect(us.access_token)).json();
    const second = await (await introspect(eu.access_token)).json();
    expect(first).toMatchObject({ active: true, client_id: "client-a", aud: resource, galaxy_connections: [{ instance: "us", api_key: keys.us, url: config.instances.us }] });
    expect(second).toMatchObject({ active: true, client_id: "client-b", galaxy_connections: [{ instance: "eu", api_key: keys.eu }] });
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
    for (const changes of [{ csrf: "wrong" }, { consent: "no" }, { "api_key.us": "wrong" }, { instance: "https://attacker.test" }, { api_key: "wrong" }]) {
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
    expect(await (await introspect(first.access_token)).json()).toMatchObject({ active: true, galaxy_connections: [{ api_key: keys.us }] });
    const refresh = () => tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: first.refresh_token, resource });
    const refreshed = await refresh();
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as Tokens;
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expect((await refresh()).status).toBe(400);
    expect(await (await introspect(rotated.access_token)).json()).toEqual({ active: false });
    expect(await (await introspect(other.access_token)).json()).toMatchObject({ active: true, galaxy_connections: [{ api_key: keys.eu }] });
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

  it("defaults an omitted native authorization scope without expanding explicit scopes", async () => {
    const response = await exchange(await codeFor("us", "galaxy-grok-build", undefined, { scope: undefined }));
    expect(response.status).toBe(200);
    const issued = await response.json() as Tokens;
    expect(issued.scope).toBe("galaxy:full");
    expect(await (await introspect(issued.access_token)).json()).toMatchObject({
      active: true, client_id: "galaxy-grok-build", galaxy_connections: [{ instance: "us" }],
    });
    const explicit = await authorization("client-a", { scope: "openid" });
    const interaction = await broker.provider.Interaction.find(new URL(explicit.location).pathname.split("/").at(-1)!);
    expect(interaction?.params.scope).toBe("openid");
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
    expect(await (await introspect(changedTokens.access_token)).json()).toMatchObject({ active: true, galaxy_connections: [{ instance: "eu" }] });
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
      await store.saveCredential(id, { accountId: `fixture-${id}`, clientId: "client-a", instance: "us", audience: resource, connections: [{ instance: "us", apiKey: keys.us, baseUrl: config.instances.us! }] }, Date.now() + 60000);
      await expect(store.saveCredential(id, { accountId: "other", clientId: "client-a", instance: "eu", audience: resource, connections: [{ instance: "eu", apiKey: keys.eu, baseUrl: config.instances.eu! }] }, Date.now() + 60000)).rejects.toThrow();
      expect(await store.credential(id)).toMatchObject({ instance: "us", connections: [{ instance: "us" }] });
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
  it("signs in to a site through its login provider, refreshes the token once for concurrent requests, and drops the site when the sign-in ends", async () => {
    // A login provider like auth.usegalaxy.org: PKCE codes, and refresh tokens it accepts only once.
    const provider = { codes: new Map<string, { challenge: string; user: string | null }>(), refresh: new Map<string, string | null>(),
      refreshes: 0, ended: false, nextUser: "signin-user" as string | null, count: 0 };
    const clientSecret = "fixture-signin-client-secret";
    const realm = () => `${address(idp)}/realms/galaxy-test`;
    const issue = (user: string | null) => {
      const access = `fixture-access-${++provider.count}`;
      const refresh = `fixture-refresh-${provider.count}`;
      bearerUsers.set(access, user);
      provider.refresh.set(refresh, user);
      return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 300 };
    };
    const idp = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://fixture");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/realms/galaxy-test/.well-known/openid-configuration") {
        res.end(JSON.stringify({ issuer: realm(), authorization_endpoint: `${realm()}/auth`, token_endpoint: `${realm()}/token`, code_challenge_methods_supported: ["S256"] }));
      } else if (url.pathname === "/realms/galaxy-test/auth") {
        expect(url.searchParams.get("client_id")).toBe("galaxy-mcp");
        expect(url.searchParams.get("redirect_uri")).toBe(`${config.issuer}/interaction/keycloak/callback`);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        const code = randomBytes(8).toString("hex");
        provider.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, user: provider.nextUser });
        res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state")!)}` }).end();
      } else if (url.pathname === "/realms/galaxy-test/token" && req.method === "POST") {
        expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`galaxy-mcp:${clientSecret}`).toString("base64")}`);
        let body = "";
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "authorization_code") {
          const issued = provider.codes.get(form.get("code")!);
          provider.codes.delete(form.get("code")!);
          if (!issued || createHash("sha256").update(form.get("code_verifier")!).digest("base64url") !== issued.challenge) { res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" })); return; }
          res.end(JSON.stringify(issue(issued.user)));
        } else {
          provider.refreshes++;
          const token = form.get("refresh_token")!;
          // A replayed refresh token ends the whole session, as the realm is configured to do.
          if (provider.ended || !provider.refresh.has(token)) { provider.ended = true; res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" })); return; }
          const user = provider.refresh.get(token)!;
          provider.refresh.delete(token);
          await new Promise(resolve => setTimeout(resolve, 50));
          res.end(JSON.stringify(issue(user)));
        }
      } else res.writeHead(404).end("{}");
    });
    idp.listen(0, "127.0.0.1"); await once(idp, "listening");
    const signInConfig: BrokerConfig = { ...config, instances: { ...config.instances, test: `${address(galaxy)}/signin` },
      galaxyLogins: { test: { issuer: realm(), client_id: "galaxy-mcp", client_secret: clientSecret } } };
    await broker.close(); broker = await createBroker(signInConfig); handler = broker.callback;
    /** Connects with the given fields, following the provider's login page; returns the response back at the broker. */
    const connect = async (fields: Record<string, string>, browser = new Browser()) => {
      const auth = await authorization("client-a", {}, browser);
      const submitted = await auth.browser.request(auth.location, { method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(ticked({ csrf: auth.csrf, consent: "yes", action: "connect", ...fields })) });
      expect(submitted.status).toBe(200);
      expect(submitted.headers.get("content-security-policy")).toContain("form-action 'self'");
      const html = await submitted.text();
      expect(html).not.toMatch(/fixture-.*-key/);
      // The provider is reached by navigation, not by redirecting a form submission past form-action.
      const target = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&");
      expect(target.startsWith(`${realm()}/auth?`)).toBe(true);
      const login = await fetch(target, { redirect: "manual" });
      return { auth, back: login.headers.get("location")! };
    };
    try {
      const form = await authorization();
      expect(form.html).not.toContain('name="method.us"');
      expect(form.html).toContain(`Never used Keycloak on ${new URL(signInConfig.instances.test!).host}? <a href="${signInConfig.instances.test}/login/start"`);
      // Ticking the site opens it with signing in chosen; the API key is the other choice.
      expect(form.html).toMatch(/name="site\.test" value="yes">[^]*name="method\.test" value="login" checked>[^]*name="method\.test" value="key"><span>Use an API key instead<\/span>[^]*name="api_key\.test"/);
      expect(form.html).toContain(`href="${config.instances.us}/user/api_key"`);
      expect(form.html).toContain("return to <strong>client-a on this computer (127.0.0.1)</strong>");

      const { auth, back } = await connect({ "login.test": "yes", "api_key.us": keys.us });
      const returned = await auth.browser.request(back);
      expect(returned.status).toBe(303);
      // The provider's response works once.
      expect((await auth.browser.request(back)).status).toBe(400);
      // Only the browser that started connecting can finish: the interaction cookie is scoped to its path.
      expect((await new Browser().request(returned.headers.get("location")!)).status).toBe(400);
      let response = await resume(auth, await auth.browser.request(returned.headers.get("location")!));
      while (response.status === 303 && new URL(response.headers.get("location")!, config.issuer).origin === config.issuer) {
        response = await auth.browser.request(new URL(response.headers.get("location")!, config.issuer).href);
      }
      const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
      const issued = await (await exchange({ ...auth, code })).json() as Tokens;
      expect(await (await introspect(issued.access_token)).json()).toMatchObject({ active: true, galaxy_connections: [
        { instance: "test", access_token: "fixture-access-1", url: signInConfig.instances.test },
        { instance: "us", api_key: keys.us, url: config.instances.us },
      ] });
      expect(provider.refreshes).toBe(0);
      const stored = await database.query<{ payload: Buffer }>("SELECT payload FROM galaxy_broker_credentials");
      expect(stored.rows.every(row => !row.payload.includes("fixture-refresh-") && !row.payload.includes("fixture-access-"))).toBe(true);

      // The service sends the sign-in to Galaxy as a bearer token, never as an API key.
      const service = await loadUniversalAuth({ metadataUrl: `${config.issuer}/.well-known/oauth-authorization-server`,
        introspectionClientId: config.resourceClientId, introspectionClientSecret: config.resourceClientSecret,
        instancesJson: JSON.stringify(signInConfig.instances), resourceServerUrl: resource });
      const mcp = await startTestService({ auth: service });
      try {
        const request = modernRequest("tools/call", { name: "get_histories", arguments: { instance: "test" } });
        request.headers.set("authorization", `Bearer ${issued.access_token}`);
        const payload = await (await fetch(`${mcp.baseUrl}/mcp`, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) })).json();
        expect(payload.result.structuredContent).toMatchObject({ galaxy: { instance: "test" }, histories: [{ name: "Signed-in test history" }] });
        expect(apiRequests).toContain("GET /signin/api/histories bearer:fixture-access-1 key:");
        expect(mcp.logs.join(" ")).not.toContain("fixture-access-1");
      } finally { await mcp.stop(); }

      // Close to expiry, concurrent requests wait for one refresh; the provider would end the session on a replay.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 250_000);
      const concurrent = await Promise.all(Array.from({ length: 5 }, async () => (await introspect(issued.access_token)).json()));
      expect(provider.refreshes).toBe(1);
      for (const value of concurrent) expect(value.galaxy_connections).toContainEqual({ instance: "test", access_token: "fixture-access-2", url: signInConfig.instances.test });

      // When the provider ends the sign-in, the site is left out until the user connects again; other sites keep working.
      provider.ended = true;
      vi.setSystemTime(Date.now() + 250_000);
      const renewed = await (await tokenRequest({ client_id: "client-a", grant_type: "refresh_token", refresh_token: issued.refresh_token, resource })).json() as Tokens;
      expect(await (await introspect(renewed.access_token)).json()).toMatchObject({ active: true, galaxy_connections: [{ instance: "us", api_key: keys.us, url: config.instances.us }] });
      expect((await (await introspect(renewed.access_token)).json()).galaxy_connections).toHaveLength(1);
      expect(provider.refreshes).toBe(2);
      vi.useRealTimers();
      expect(await (await introspect(renewed.access_token)).json()).toMatchObject({ galaxy_sign_in_needed: [{ instance: "test", url: signInConfig.instances.test }] });

      // The management page marks the ended sign-in; signing in again restores that site alone.
      provider.ended = false;
      const renewing = new Browser();
      const expiredPage = await managementPage(renewed.access_token, renewing);
      expect(expiredPage).toContain('<span class="status warn">Sign-in expired</span>');
      const renewForm = await (await managementPost("action", { action_token: buttonToken(expiredPage, "Sign in again")! }, renewing)).text();
      expect(renewForm).toContain("<h1>Change test</h1>");
      expect(renewForm).toContain('<span class="status">Now: Sign-in expired</span>');
      const renewSave = /action="\/connections\/save"><input type="hidden" name="action_token" value="([^"]+)"/.exec(renewForm)![1]!;
      const toProvider = await managementPost("save", { action_token: renewSave, consent: "yes", "login.test": "yes" }, renewing);
      const renewAt = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(await toProvider.text())![1]!.replaceAll("&amp;", "&");
      const renewed2 = await renewing.request((await fetch(renewAt, { redirect: "manual" })).headers.get("location")!);
      expect(await renewed2.text()).toContain("test updated.");
      const restored = await (await introspect(renewed.access_token)).json() as { galaxy_connections: Array<{ instance: string }> };
      expect(restored.galaxy_connections.map(value => value.instance)).toEqual(["test", "us"]);
      expect(restored).not.toHaveProperty("galaxy_sign_in_needed");

      // A sign-in Galaxy has not linked to an account yet says what to do instead of failing silently.
      provider.ended = false;
      provider.nextUser = null;
      const unlinked = await connect({ "login.test": "yes" });
      const refused = await unlinked.auth.browser.request(unlinked.back);
      expect(refused.status).toBe(400);
      expect(refused.headers.get("content-type")).toContain("text/html");
      const refusal = await refused.text();
      expect(refusal).toContain("has not seen this account yet.");
      expect(refusal).toContain("<ol><li>Open 127.0.0.1:");
      expect(refusal).toContain(`href="${signInConfig.instances.test}/login/start"`);
      // The same browser can go back to the form and try again while the interaction lasts.
      const backTo = /<a class="button secondary" href="([^"]+)">Back to Connect Galaxy<\/a>/.exec(refusal)![1]!;
      const again = await unlinked.auth.browser.request(new URL(backTo, config.issuer).href);
      expect(again.status).toBe(200);
      expect(await again.text()).toContain('name="method.test"');

      // Cancelling at the provider, a replayed callback, and a key together with sign-in for one site are refused.
      provider.nextUser = "signin-user";
      const cancelled = await connect({ "login.test": "yes" });
      const url = new URL(cancelled.back);
      url.searchParams.delete("code"); url.searchParams.set("error", "access_denied");
      expect(await (await cancelled.auth.browser.request(url.href)).text()).toContain("was not completed");
      expect((await cancelled.auth.browser.request(cancelled.back)).status).toBe(400);
      const both = await authorization();
      // Choosing the API key for a ticked site needs the key; the page says so and offers a way back.
      const bothRefused = (await both.browser.request(both.location, { method: "POST", headers: { origin: config.issuer, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: both.csrf, consent: "yes", action: "connect", "site.test": "yes", "method.test": "key", "api_key.test": "" }) }));
      expect(bothRefused.status).toBe(400);
      const bothText = await bothRefused.text();
      expect(bothText).toContain("API key missing");
      expect(bothText).toContain(`<a class="button" href="/interaction/`);

      // A key-only connection can add the site by signing in from the management page, with no browser cookie.
      const plain = await tokens("us");
      const managing = new Browser();
      const addForm = await (await managementPost("action", { action_token: buttonToken(await managementPage(plain.access_token, managing), "Add a Galaxy site")! }, managing)).text();
      expect(addForm).toContain('name="method.test"');
      expect(addForm).toContain("Never used Keycloak on");
      const addSave = /action="\/connections\/save"><input type="hidden" name="action_token" value="([^"]+)"/.exec(addForm)![1]!;
      const leaving = await managementPost("save", { action_token: addSave, consent: "yes", "login.test": "yes" }, managing);
      expect(leaving.status).toBe(200);
      const providerUrl = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(await leaving.text())![1]!.replaceAll("&amp;", "&");
      expect(providerUrl.startsWith(`${realm()}/auth?`)).toBe(true);
      const returning = (await fetch(providerUrl, { redirect: "manual" })).headers.get("location")!;
      const finished = await managing.request(returning);
      expect(finished.status).toBe(200);
      const finishedPage = await finished.text();
      expect(finishedPage).toContain("test updated.");
      expect(finishedPage).toContain('<span class="status">Signed in with Keycloak</span>');
      expect(managing.cookies.size).toBe(0);
      const added = await (await introspect(plain.access_token)).json() as { galaxy_connections: Array<{ instance: string; access_token?: string; api_key?: string }> };
      expect(added.galaxy_connections.map(value => value.instance)).toEqual(["test", "us"]);
      expect(added.galaxy_connections[0]!.access_token).toMatch(/^fixture-access-/);
      // The provider's response is single-use here too.
      expect((await managing.request(returning)).status).toBe(400);

      // When the only site's sign-in ends, the grant stays active so the user can sign in again from management.
      await database.query("DELETE FROM galaxy_broker_limits"); // this test alone reaches the per-address limit
      const only = await connect({ "login.test": "yes" });
      const onlyBack = await only.auth.browser.request(only.back);
      expect(onlyBack.status).toBe(303);
      let onlyResponse = await resume(only.auth, await only.auth.browser.request(onlyBack.headers.get("location")!));
      while (onlyResponse.status === 303 && new URL(onlyResponse.headers.get("location")!, config.issuer).origin === config.issuer) {
        onlyResponse = await only.auth.browser.request(new URL(onlyResponse.headers.get("location")!, config.issuer).href);
      }
      const onlyTokens = await (await exchange({ ...only.auth, code: new URL(onlyResponse.headers.get("location")!).searchParams.get("code")! })).json() as Tokens;
      provider.ended = true;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 250_000);
      expect(await (await introspect(onlyTokens.access_token)).json()).toMatchObject({
        active: true, galaxy_connections: [], galaxy_sign_in_needed: [{ instance: "test", url: signInConfig.instances.test }],
      });
      expect((await managementLink(onlyTokens.access_token)).status).toBe(200);
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      await close(idp);
      await broker.close(); broker = await createBroker(config); handler = broker.callback;
    }
  });
});
