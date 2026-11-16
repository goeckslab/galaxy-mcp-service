import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { Provider, errors, interactionPolicy, type ClientMetadata, type KoaContextWithOIDC, type JWKS } from "oidc-provider";
import { subscribeParams, unsubscribeParams, eventState } from "@galaxy-mcp-service/protocol";
import { z } from "zod";

import { createStore } from "./store.js";

export interface BrokerConfig {
  issuer: string;
  resource: string;
  databaseUrl: string;
  encryptionKey: Buffer;
  cookieKeys: string[];
  jwks: JWKS;
  clients: ClientMetadata[];
  resourceClientId: string;
  resourceClientSecret: string;
  instances: Record<string, string>;
  allowLoopback?: boolean;
  trustProxy?: boolean;
}

function secureUrl(value: string, allowLoopback: boolean) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Broker URLs must use HTTPS without credentials, query or fragment.");
  }
  return url;
}
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

function basicCredential(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function isClaudeMetadataUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://claude.ai" && url.pathname.startsWith("/oauth/")
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

// Public registrations use documented callbacks, not a wildcard or open DCR.
// URL client IDs let native clients use their published identity automatically.
// Claude Code omits OIDC's application_type; VS Code also declares device_code.
// Register their code flow explicitly instead of changing vendor metadata or
// enabling another grant. PKCE and user consent remain required for every client.
const publicClients: ClientMetadata[] = [
  { client_id: "https://chatgpt.com/oauth/codex/client.json", client_name: "Codex", application_type: "native",
    redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"], token_endpoint_auth_method: "none" },
  { client_id: "https://claude.ai/oauth/claude-code-client-metadata", client_name: "Claude Code", application_type: "native",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" },
  { client_id: "https://vscode.dev/oauth/client-metadata.json", client_name: "Visual Studio Code", application_type: "native",
    redirect_uris: ["http://127.0.0.1/", "https://vscode.dev/redirect"], token_endpoint_auth_method: "none" },
  { client_id: "galaxy-cursor", client_name: "Cursor", application_type: "native",
    redirect_uris: ["http://localhost:8787/callback", "https://www.cursor.com/agents/mcp/oauth/callback"], token_endpoint_auth_method: "none" },
  { client_id: "galaxy-gemini-cli", client_name: "Gemini CLI", application_type: "native",
    redirect_uris: ["http://localhost/oauth/callback"], token_endpoint_auth_method: "none" },
  { client_id: "galaxy-grok-build", client_name: "Grok Build", application_type: "native",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" },
  { client_id: "https://grok.com/oauth/mcp-client.json", client_name: "Grok", application_type: "web",
    redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/", "https://console.x.ai/connectors-oauth-exchange-code/"], token_endpoint_auth_method: "none" },
];

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readForm(req: IncomingMessage, allowed: ReadonlySet<string>) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65536) throw new errors.InvalidRequest("Form is too large.");
    chunks.push(buffer);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  for (const name of form.keys()) {
    if (!allowed.has(name) || form.getAll(name).length !== 1) throw new errors.InvalidRequest("Invalid form.");
  }
  return form;
}

async function identityBody(response: Response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new errors.InvalidRequest("Galaxy identity could not be verified.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new errors.InvalidRequest("Galaxy identity response is too large.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

export async function createBroker(config: BrokerConfig) {
  const issuer = secureUrl(config.issuer, config.allowLoopback === true);
  const resource = secureUrl(config.resource, config.allowLoopback === true).href;
  if (issuer.pathname !== "/" || config.issuer.endsWith("/")) throw new Error("Broker issuer must be an origin without a trailing slash.");
  if (!config.cookieKeys.length || config.cookieKeys.some((key) => Buffer.byteLength(key) < 32)
    || config.resourceClientSecret.length < 32 || !config.resourceClientId
    || !config.jwks.keys.some((key) => "d" in key)) {
    throw new Error("Broker requires persistent strong cookie, signing, encryption and resource-client keys.");
  }
  // An operator's explicit registration takes precedence over the built-in profile.
  const clients = [...config.clients, ...publicClients.filter(client => !config.clients.some(value => value.client_id === client.client_id))];
  if (!config.clients.length || clients.some((client) => client.client_id === config.resourceClientId)) {
    throw new Error("Configure distinct application and resource-server clients.");
  }
  for (const client of clients) {
    if (!client.redirect_uris?.length || client.response_types?.some((value) => value !== "code")
      || client.grant_types?.some((value) => !["authorization_code", "refresh_token"].includes(value))) {
      throw new Error("Broker application clients must use authorization code flow.");
    }
  }
  const instances = new Map(Object.entries(config.instances).map(([name, value]) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid Galaxy instance name.");
    return [name, secureUrl(value, config.allowLoopback === true).href.replace(/\/$/, "")];
  }));
  if (!instances.size) throw new Error("Configure at least one approved Galaxy instance.");
  const store = await createStore(config.databaseUrl, config.encryptionKey);
  const formStore = new store.adapter("LoginForm");
  const managementTicketStore = new store.adapter("ManagementTicket");
  const managementActionStore = new store.adapter("ManagementAction");
  const clientNames = new Map(clients.map(client => [client.client_id, client.client_name || client.client_id]));
  const policy = interactionPolicy.base();
  policy.get("login")!.checks.add(new interactionPolicy.Check(
    "galaxy_connection", "Choose and authorize a Galaxy connection.",
    (ctx) => !ctx.oidc.result?.login,
  ));
  const lifetime = 30 * 24 * 60 * 60;
  let provider: Provider;
  try {
    provider = new Provider(config.issuer, {
      adapter: store.adapter,
      clients: [
        ...clients.map((client): ClientMetadata => ({
          ...client, response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"], scope: "galaxy:full offline_access openid",
        })),
        { client_id: config.resourceClientId, client_secret: config.resourceClientSecret,
          response_types: [], grant_types: [], token_endpoint_auth_method: "client_secret_basic" },
      ],
      jwks: config.jwks,
      discovery: { introspection_endpoint_auth_methods_supported: ["client_secret_basic"], galaxy_run_events_supported: true },
      cookies: {
        keys: config.cookieKeys,
        long: { httpOnly: true, sameSite: "lax", secure: issuer.protocol === "https:" },
        short: { httpOnly: true, sameSite: "lax", secure: issuer.protocol === "https:" },
      },
      interactions: { policy },
      pkce: { required: () => true },
      scopes: ["galaxy:full", "offline_access"],
      features: {
        // Use the provider's bounded, non-redirecting CIMD fetch and metadata validation.
        // Trust only Claude's published origin, not arbitrary client-supplied URLs.
        clientIdMetadataDocument: {
          enabled: true,
          ack: "draft-02",
          allowFetch: (_ctx, clientId) => isClaudeMetadataUrl(clientId),
          allowClient: (_ctx, client) => isClaudeMetadataUrl(client.clientId)
            && client.clientAuthMethod === "none"
            && Boolean(client.grantTypes?.includes("authorization_code"))
            && Boolean(client.grantTypes?.every(value => ["authorization_code", "refresh_token"].includes(value)))
            && Boolean(client.responseTypes?.length && client.responseTypes.every(value => value === "code"))
            && Boolean(client.redirectUris?.length && client.redirectUris.every(value => value === "https://claude.ai/api/mcp/auth_callback")),
        },
        devInteractions: { enabled: false },
        userinfo: { enabled: false },
        revocation: { enabled: true },
        introspection: {
          enabled: true,
          allowedPolicy: (_ctx, client, token) => client.clientId === config.resourceClientId
            && client.clientAuthMethod === "client_secret_basic"
            && token.kind === "AccessToken" && token.aud === resource && Boolean(token.accountId && token.grantId),
        },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => resource,
          useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, indicator) => {
            if (indicator !== resource) throw new errors.InvalidTarget();
            return { scope: "galaxy:full", audience: resource, accessTokenFormat: "opaque", accessTokenTTL: 600 };
          },
        },
      },
      ttl: { AccessToken: 600, AuthorizationCode: 60, RefreshToken: lifetime, Grant: lifetime, Session: 3600, Interaction: 600 },
      rotateRefreshToken: true,
      revokeGrantPolicy: () => true,
      // Our own explicit consent covers this connection's fixed 30-day grant, not a browser session.
      expiresWithSession: () => false,
      issueRefreshToken: (_ctx, client, source) => client.grantTypeAllowed("refresh_token") && source.scopes.has("galaxy:full"),
      loadExistingGrant: async (ctx) => {
        const id = ctx.oidc.result?.consent?.grantId;
        return id ? provider.Grant.find(id) : undefined;
      },
      findAccount: async (_ctx, accountId) => await store.hasAccount(accountId)
        ? { accountId, claims: () => ({ sub: accountId }) } : undefined,
      renderError: (ctx) => { ctx.type = "text"; ctx.body = "Authorization could not be completed. Start connecting again."; },
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  provider.proxy = config.trustProxy === true;
  provider.maxIpsCount = 1;
  provider.silent = true;
  provider.on("server_error", () => console.error("Broker request failed."));
  provider.use(async (ctx, next) => {
    ctx.set("Cache-Control", "no-store");
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.set("Referrer-Policy", "no-referrer");
    ctx.set("X-Frame-Options", "DENY");
    if (ctx.path === "/readyz" && ctx.method === "GET") {
      try { await store.ready(); ctx.body = { status: "ready" }; }
      catch { ctx.status = 503; ctx.body = { status: "unavailable" }; }
      return;
    }
    if (ctx.get("host") !== issuer.host || (issuer.protocol === "https:" && ctx.protocol !== "https")) {
      ctx.status = 400; ctx.body = "Invalid broker origin."; return;
    }
    if (ctx.path === "/auth" && ctx.method === "GET") {
      const params = new URLSearchParams(ctx.querystring);
      // OAuth scope is optional (RFC 6749 §3.3). Keep explicit/signed requests
      // unchanged; the default still requires the same explicit Galaxy consent.
      if (!params.has("scope") && !params.has("request") && !params.has("request_uri")) {
        params.set("scope", "galaxy:full");
        ctx.querystring = params.toString();
      }
    }
    const eventAction = /^\/events\/(prepare|subscribe|unsubscribe|claim|check|save)$/.exec(ctx.path)?.[1];
    if (eventAction) {
      try {
        if (ctx.method !== "POST" || !ctx.is("application/x-www-form-urlencoded")) { ctx.status = 405; return; }
        const expected = `Basic ${Buffer.from(`${basicCredential(config.resourceClientId)}:${basicCredential(config.resourceClientSecret)}`).toString("base64")}`;
        if (!sameSecret(ctx.get("authorization"), expected)) { ctx.status = 401; return; }
        const form = await readForm(ctx.req, new Set(["payload"]));
        const body: unknown = JSON.parse(form.get("payload") || "");
        if (["prepare", "subscribe", "unsubscribe"].includes(eventAction)) {
          const input = z.object({ token: z.string().min(1), params: eventAction === "unsubscribe" ? unsubscribeParams : subscribeParams,
            verified_at: z.number().int().optional() }).strict().parse(body);
          const access = await provider.AccessToken.find(input.token);
          const audiences = typeof access?.aud === "string" ? [access.aud] : access?.aud;
          const credential = access?.grantId ? await store.credential(access.grantId) : undefined;
          if (!access?.accountId || !access.grantId || !access.isValid || !access.scope?.split(" ").includes("galaxy:full")
            || !audiences?.includes(resource) || !credential || credential.accountId !== access.accountId
            || credential.clientId !== access.clientId || credential.audience !== resource) { ctx.status = 401; return; }
          if (eventAction === "unsubscribe") {
            await store.unsubscribeEvent(access.grantId, unsubscribeParams.parse(input.params));
            ctx.body = {}; return;
          }
          const params = subscribeParams.parse(input.params);
          const connection = credential.connections.find(value => value.instance === params.arguments.instance);
          if (!connection || connection.baseUrl !== instances.get(connection.instance)) { ctx.status = 403; return; }
          if (!await store.rateLimit(`events:${access.grantId}`)) { ctx.status = 429; return; }
          if (eventAction === "prepare") ctx.body = await store.prepareEvent(access.grantId, params);
          else {
            if (!input.verified_at || input.verified_at > Date.now() || input.verified_at < Date.now() - 300000) { ctx.status = 400; return; }
            ctx.body = await store.subscribeEvent(access.grantId, params, input.verified_at);
          }
        } else if (eventAction === "claim") {
          z.object({}).strict().parse(body);
          const item = await store.claimEvent(resource);
          if (item && item.connection.baseUrl !== instances.get(item.connection.instance)) {
            await store.saveEvent(item.subscription.id, item.revision, item.lease, { phase: "stopped", attempts: 0 }, 0, true);
            ctx.body = { item: null };
          } else ctx.body = { item };
        } else {
          const identity = z.object({ id: z.string().regex(/^sub_[a-f0-9]{64}$/), revision: z.number().int().positive(), lease: z.string().min(1).max(100) });
          if (eventAction === "check") {
            const input = identity.strict().parse(body);
            const item = await store.checkEvent(input.id, input.revision, input.lease);
            ctx.body = { item: item && item.connection.baseUrl === instances.get(item.connection.instance) ? item : null };
          } else {
            const input = identity.extend({ state: eventState, delay_ms: z.number().int().min(0).max(900000), release: z.boolean() }).strict().parse(body);
            ctx.body = { saved: await store.saveEvent(input.id, input.revision, input.lease, input.state, input.delay_ms, input.release) };
          }
        }
      } catch { ctx.status = 400; ctx.body = { error: "Run subscription request could not be completed." }; }
      return;
    }
    const managementCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
    const managementError = () => {
      ctx.status = 400;
      ctx.type = "text";
      ctx.body = "This connection-management link is invalid, expired or already used. Request a new link from your AI client.";
    };
    const actionToken = async (payload: Record<string, string>) => {
      const token = randomBytes(32).toString("base64url");
      await managementActionStore.upsert(token, payload, 600);
      return token;
    };
    const renderConnections = async (accountId: string, sourceGrant: string, notice = "") => {
      const credential = await store.managedCredential(accountId, sourceGrant);
      let card = "";
      if (credential) {
        const sites = await Promise.all(credential.connections.map(async ({ instance, baseUrl }) => {
          const token = await actionToken({ accountId, sourceGrant, operation: "remove", targetGrant: credential.grantId, instance });
          return `<li><div><strong>${escape(instance)}</strong><br><a href="${escape(baseUrl)}" target="_blank" rel="noopener noreferrer">${escape(baseUrl)}</a></div>
            <form method="post" action="/connections/action"><input type="hidden" name="action_token" value="${token}"><button class="secondary">Remove site</button></form></li>`;
        }));
        const token = await actionToken({ accountId, sourceGrant, operation: "revoke", targetGrant: credential.grantId });
        card = `<section><h2>${escape(clientNames.get(credential.clientId) || credential.clientId)}</h2><p>Can browse Galaxy data and run analyses. Expires ${escape(new Date(credential.expiresAt).toISOString())}.</p><ul>${sites.join("")}</ul>
          <form method="post" action="/connections/action"><input type="hidden" name="action_token" value="${token}"><button class="danger">Disconnect this client</button></form></section>`;
      }
      ctx.set("Referrer-Policy", "same-origin");
      ctx.type = "html";
      ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage Galaxy connections</title>
        <style>body{font:16px system-ui;background:#f5f5f7;color:#1d1d1f;margin:0;padding:32px}main{max-width:720px;margin:5vh auto}header,section,.empty,.notice{background:white;border-radius:24px;padding:28px;margin:16px 0;box-shadow:0 12px 48px #0001}.notice{background:#eaf5ed;color:#175c2e}h1,h2{margin-top:0}p{line-height:1.5;color:#555}ul{list-style:none;padding:0}li{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 0;border-top:1px solid #eee}a{color:#06c;overflow-wrap:anywhere}button{font:inherit;padding:10px 14px;border:0;border-radius:10px;cursor:pointer}.secondary{background:#eee;color:#222}.danger{background:#b42318;color:white}footer{color:#666;padding:12px 4px}@media(max-width:600px){body{padding:16px}li{align-items:flex-start;flex-direction:column}}</style>
        <main><header><p>Galaxy MCP</p><h1>Manage connections</h1><p>This page was opened from an active plugin authorization. It does not use a browser login cookie, and API keys are never displayed.</p></header>
        ${notice ? `<div class="notice" role="status">${escape(notice)}</div>` : ""}
        ${card || '<div class="empty"><h2>No active connection</h2><p>This plugin authorization is no longer active. Reconnect Galaxy from your AI client when you want to use it again.</p></div>'}
        <footer><p>Each button is valid once for ten minutes. To rotate an API key, disconnect the affected connection, rotate the key in Galaxy, then reconnect from your AI client. Rotating the key in Galaxy immediately disables the old key.</p></footer></main></html>`;
    };
    if (ctx.path === "/management/ticket") {
      try {
        if (ctx.method !== "POST" || !ctx.is("application/x-www-form-urlencoded")) { ctx.status = 405; return; }
        const expected = `Basic ${Buffer.from(`${basicCredential(config.resourceClientId)}:${basicCredential(config.resourceClientSecret)}`).toString("base64")}`;
        if (!sameSecret(ctx.get("authorization"), expected)) { ctx.status = 401; return; }
        const form = await readForm(ctx.req, new Set(["token"]));
        const token = form.get("token");
        const access = token ? await provider.AccessToken.find(token) : undefined;
        const audiences = typeof access?.aud === "string" ? [access.aud] : access?.aud;
        if (!access?.accountId || !access.grantId || !audiences?.includes(resource) || !access.isValid) { ctx.status = 401; return; }
        const ticket = randomBytes(32).toString("base64url");
        await managementTicketStore.upsert(ticket, { accountId: access.accountId, sourceGrant: access.grantId }, 300);
        ctx.body = { url: `${issuer.origin}/connections/${ticket}`, expires_in: 300 };
      } catch { managementError(); }
      return;
    }
    if (ctx.path === "/connections" && ctx.method === "GET") {
      ctx.set("Content-Security-Policy", managementCsp);
      ctx.type = "html";
      ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage Galaxy connections</title><style>body{font:16px system-ui;background:#f5f5f7;color:#1d1d1f;margin:0;padding:32px}main{max-width:640px;margin:8vh auto;background:white;border-radius:24px;padding:32px;box-shadow:0 12px 48px #0001}p{line-height:1.5}a{color:#06c}</style><main><h1>Manage Galaxy connections</h1><p>Ask your connected AI assistant to “manage my Galaxy connections.” It will create a private five-minute link using the plugin's current authorization. Browser cookies are not used.</p><p><a href="${escape(new URL("/support", resource).href)}">Get help</a></p></main></html>`;
      return;
    }
    const ticketMatch = /^\/connections\/([A-Za-z0-9_-]{43})$/.exec(ctx.path);
    if (ticketMatch) {
      ctx.set("Content-Security-Policy", managementCsp);
      try {
        if (ctx.method !== "GET" || !await managementTicketStore.find(ticketMatch[1]!)) { managementError(); return; }
        // Its form POST needs a non-null Origin, as on the consent page.
        ctx.set("Referrer-Policy", "same-origin");
        ctx.type = "html";
        ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Galaxy connection management</title><style>body{font:16px system-ui;background:#f5f5f7;color:#1d1d1f;margin:0;padding:32px}main{max-width:560px;margin:8vh auto;background:white;border-radius:24px;padding:32px;box-shadow:0 12px 48px #0001}p{line-height:1.5;color:#555}button{font:inherit;width:100%;padding:12px;border:0;border-radius:10px;background:#0068da;color:white;cursor:pointer}</style><main><h1>Manage Galaxy connections</h1><p>Continue to view the Galaxy sites authorized by your active plugin connection. This private link works once and does not use a browser login cookie.</p><form method="post" action="/connections/start"><input type="hidden" name="ticket" value="${ticketMatch[1]}"><button>Continue</button></form></main></html>`;
      } catch { managementError(); }
      return;
    }
    if (ctx.path === "/connections/start" || ctx.path === "/connections/action") {
      ctx.set("Content-Security-Policy", managementCsp);
      try {
        if (ctx.method !== "POST" || ctx.get("origin") !== issuer.origin || !ctx.is("application/x-www-form-urlencoded")
          || !await store.rateLimit(ctx.ip || "unknown")) throw new errors.InvalidRequest("Invalid management request.");
        if (ctx.path === "/connections/start") {
          const form = await readForm(ctx.req, new Set(["ticket"]));
          const ticket = form.get("ticket") || "";
          const saved = await managementTicketStore.find(ticket) as { accountId?: unknown; sourceGrant?: unknown } | undefined;
          if (typeof saved?.accountId !== "string" || typeof saved.sourceGrant !== "string") throw new errors.InvalidRequest("Invalid management request.");
          await managementTicketStore.consume(ticket);
          await renderConnections(saved.accountId, saved.sourceGrant);
        } else {
          const form = await readForm(ctx.req, new Set(["action_token"]));
          const token = form.get("action_token") || "";
          const saved = await managementActionStore.find(token) as {
            accountId?: unknown; sourceGrant?: unknown; operation?: unknown; targetGrant?: unknown; instance?: unknown;
          } | undefined;
          if (typeof saved?.accountId !== "string" || typeof saved.sourceGrant !== "string" || typeof saved.operation !== "string") throw new errors.InvalidRequest("Invalid management request.");
          await managementActionStore.consume(token);
          let changed = false;
          if (typeof saved.targetGrant === "string") {
            changed = saved.operation === "revoke"
              ? await store.revokeCredential(saved.accountId, saved.targetGrant)
              : saved.operation === "remove" && typeof saved.instance === "string"
                ? await store.removeConnection(saved.accountId, saved.targetGrant, saved.instance)
                : false;
          }
          if (!changed) throw new errors.InvalidRequest("Connection is no longer available.");
          await renderConnections(saved.accountId, saved.sourceGrant, saved.operation === "remove" ? "Galaxy site removed." : "Connection revoked.");
        }
      } catch { managementError(); }
      return;
    }
    const match = /^\/interaction\/([A-Za-z0-9_-]+)$/.exec(ctx.path);
    if (match) {
      ctx.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      try {
        if (!["GET", "POST"].includes(ctx.method)) { ctx.status = 405; return; }
        if (!await store.rateLimit(ctx.ip || "unknown")) { ctx.status = 429; ctx.body = "Too many attempts. Try again later."; return; }
        const details = await provider.interactionDetails(ctx.req, ctx.res);
        if (details.uid !== match[1] || !["login", "consent"].includes(details.prompt.name)) throw new errors.InvalidRequest("Invalid interaction.");
        const clientId = String(details.params.client_id);
        const client = await provider.Client.find(clientId);
        if (!client || clientId === config.resourceClientId) throw new errors.InvalidRequest("Invalid client.");
        // A fetched name is self-asserted; show the trusted metadata origin instead.
        const clientLabel = isClaudeMetadataUrl(clientId) ? "claude.ai" : client.clientName || clientId;
        const callbackHost = new URL(String(details.params.redirect_uri)).hostname;
        // Only the provider's validated interaction may supply a return location.
        const returnTo = new URL(details.returnTo);
        if (returnTo.origin !== issuer.origin || returnTo.pathname !== `/auth/${details.uid}` || returnTo.search || returnTo.hash) {
          throw new errors.InvalidRequest("Invalid return location.");
        }
        const finish = async (result: Parameters<Provider["interactionResult"]>[2]) => {
          await provider.interactionResult(ctx.req, ctx.res, result, { mergeWithLastSubmission: false });
          // End the form submission before OAuth redirects; keep form-action restricted to this origin.
          const target = escape(returnTo.href);
          ctx.type = "html";
          ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Continue connecting Galaxy</title><p><a href="${target}">Continue connecting Galaxy</a></p></html>`;
        };
        if (ctx.method === "GET") {
          // Native form POSTs need a non-null Origin; still send no referrer cross-origin.
          ctx.set("Referrer-Policy", "same-origin");
          const csrf = randomBytes(32).toString("base64url");
          await formStore.upsert(csrf, { uid: details.uid }, 600);
          const fields = [...instances].map(([name, url]) => {
            const label = url === "https://usegalaxy.org" ? "US" : name;
            return `<label for="key-${escape(name)}">${escape(label)} — ${escape(url)}</label><input id="key-${escape(name)}" name="api_key.${escape(name)}" type="password" autocomplete="off" maxlength="4096" aria-label="API key for ${escape(label)}">`;
          }).join("");
          ctx.type = "html";
          ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Galaxy</title>
            <style>body{font:16px system-ui;background:#f5f5f7;color:#1d1d1f;margin:0;padding:32px}main{max-width:480px;margin:8vh auto;background:white;border-radius:24px;padding:32px;box-shadow:0 12px 48px #0001}h1{margin-top:0}label{display:block;margin:20px 0 8px}input[type=password],select,button{box-sizing:border-box;font:inherit;width:100%;padding:12px;border:1px solid #b8b8bd;border-radius:10px}button{background:#0068da;color:white;border:0;margin-top:20px;cursor:pointer}button[value=cancel]{background:#eee;color:#222}p,small{line-height:1.5}input[type=checkbox]{margin-right:8px}</style>
            <main><h1>Connect Galaxy</h1><p><strong>${escape(clientLabel)}</strong> requests access to the Galaxy accounts you select below.</p>
            <p>After authorization, you will return to <strong>${escape(callbackHost)}</strong>.</p>
            <form method="post" action="/interaction/${escape(details.uid)}"><input type="hidden" name="csrf" value="${csrf}">
            <p>Choose from the ${instances.size} enabled Galaxy sites below. Enter your own API key only for each site you want to authorize; leave other fields blank. Each connection can include up to 10 sites. Keys belong to their individual servers; do not reuse a key on another server.</p>${fields}
            <p>Your keys are encrypted and kept for this connection for up to 30 days. They are shared only with the Galaxy MCP service, never with the AI client. Revoking this connection removes all its saved keys; simply removing an app may not send a revocation request. Your Galaxy accounts and data are not deleted. To add or replace a server, reconnect with the desired set; existing authorizations are not expanded. You can remove a server from the management page after connecting.</p>
            <label><input type="checkbox" name="consent" value="yes" required>I allow this client to read my Galaxy data and run analyses on every server for which I entered a key.</label>
            <button name="action" value="connect">Connect Galaxy</button><button name="action" value="cancel" formnovalidate>Cancel</button></form>
            <p>Missing your Galaxy site? <a href="${escape(new URL("/support#request-site", resource).href)}" target="_blank" rel="noopener noreferrer">Request a site on GitHub</a>. Requests are public and reviewed before a site is enabled. Never post API keys, passwords or private data.</p>
            <p>Later, ask your connected assistant naturally to remove a site, rotate a key or disconnect Galaxy. It will create a private management link. <a href="/connections">Learn about connection management</a>.</p>
            <small>Only connect clients you trust. To immediately disable all use of this Galaxy key, revoke it in Galaxy.</small></main></html>`;
          return;
        }
        if (ctx.get("origin") !== issuer.origin || !ctx.is("application/x-www-form-urlencoded")) throw new errors.InvalidRequest("Invalid form origin.");
        const form = await readForm(ctx.req, new Set(["csrf", "consent", "action", ...[...instances.keys()].map(name => `api_key.${name}`)]));
        const csrf = form.get("csrf") || "";
        if ((await formStore.find(csrf))?.uid !== details.uid) throw new errors.InvalidRequest("Invalid form token.");
        await formStore.consume(csrf);
        if (form.get("action") === "cancel") {
          await finish({ error: "access_denied" });
          return;
        }
        const selected = [...form].filter(([name, key]) => name.startsWith("api_key.") && key).map(([name, key]) => [name.slice(8), key]);
        if (!selected.length || selected.length > 10 || form.get("consent") !== "yes" || form.get("action") !== "connect") {
          throw new errors.InvalidRequest("Invalid connection.");
        }
        const connections = selected.map(([instance = "", apiKey = ""]) => {
          const baseUrl = instances.get(instance);
          if (!baseUrl || !apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new errors.InvalidRequest("Invalid connection.");
          return { instance, apiKey, baseUrl };
        }).sort((a, b) => a.instance.localeCompare(b.instance));
        // Verify the complete set before creating any grant; a failed site never yields partial consent.
        const identities = await Promise.all(connections.map(async ({ baseUrl, apiKey }) => {
          const response = await fetch(`${baseUrl}/api/users/current`, {
            headers: { "x-api-key": apiKey, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000),
          });
          const user = JSON.parse(await identityBody(response)) as { id?: unknown; deleted?: unknown; is_anonymous?: unknown };
          if (typeof user.id !== "string" || !user.id || user.deleted || user.is_anonymous) throw new errors.InvalidRequest("Galaxy identity could not be verified.");
          return [baseUrl, user.id];
        }));
        const accountId = createHash("sha256").update(JSON.stringify(identities)).digest("base64url");
        const grant = new provider.Grant({ accountId, clientId });
        grant.exp = Math.floor(Date.now() / 1000) + lifetime;
        grant.addResourceScope(resource, "galaxy:full");
        grant.addOIDCScope("galaxy:full offline_access openid");
        const grantId = await grant.save();
        try {
          await store.saveCredential(grantId, { accountId, clientId, audience: resource, instance: connections[0]!.instance, connections }, grant.exp! * 1000);
          await finish({
            login: { accountId, remember: false }, consent: { grantId },
          });
        } catch (error) {
          await grant.destroy();
          throw error;
        }
      } catch {
        ctx.respond = true;
        ctx.status = 400;
        ctx.type = "text";
        ctx.body = "Connection was not completed. Reload this page to try again, or start connecting again if it expired.";
      }
      return;
    }
    await next();
    const oidc = (ctx as KoaContextWithOIDC).oidc;
    if (oidc?.route === "introspection" && ctx.body && typeof ctx.body === "object" && "active" in ctx.body && ctx.body.active === true) {
      const token = oidc.accessToken;
      const credential = token?.grantId ? await store.credential(token.grantId) : undefined;
      const connections = credential?.connections;
      if (oidc.client?.clientId !== config.resourceClientId || !credential || !token || credential.accountId !== token.accountId
        || credential.clientId !== token.clientId || credential.audience !== token.aud
        || !connections?.length || connections.some(value => value.baseUrl !== instances.get(value.instance))) {
        ctx.body = { active: false };
      } else {
        Object.assign(ctx.body, {
          galaxy_connections: connections.map(value => ({ instance: value.instance, api_key: value.apiKey, url: value.baseUrl })),
        });
      }
    }
  });
  try { await store.cleanup(); } catch (error) { await store.close(); throw error; }
  const cleanup = setInterval(() => { void store.cleanup().catch(() => console.error("Broker cleanup failed.")); }, 60000);
  cleanup.unref();
  return {
    provider,
    callback: provider.callback(),
    async close() { clearInterval(cleanup); await store.close(); },
  };
}
