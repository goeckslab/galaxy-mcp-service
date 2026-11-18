import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { Provider, errors, interactionPolicy, type ClientMetadata, type KoaContextWithOIDC, type JWKS } from "oidc-provider";
import { subscribeParams, unsubscribeParams, eventState } from "@galaxy-mcp-service/protocol";
import { z } from "zod";

import { createGalaxyLogins, type GalaxyLoginConfig, type LoginTokens } from "./galaxy-login.js";
import { createStore, MAX_CONNECTIONS, usableConnections, type Connection } from "./store.js";

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
  /** Sites whose users can sign in through the site's login provider instead of pasting an API key. */
  galaxyLogins?: Record<string, GalaxyLoginConfig>;
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

/** A connection failure the person connecting can act on; its message is shown to them. */
class ConnectionProblem extends Error {
  constructor(message: string, readonly title = "Galaxy is not connected yet",
    readonly action?: { href: string; text: string }, readonly steps: string[] = []) {
    super(message);
  }
}

const cardStyle = "body{font:16px system-ui;background:#f5f5f7;color:#1d1d1f;margin:0;padding:32px}main{max-width:480px;margin:8vh auto;background:white;border-radius:24px;padding:32px;box-shadow:0 12px 48px #0001}h1{margin-top:0;font-size:26px}p,small,li{line-height:1.5}ol{padding-left:22px}li{margin:6px 0}a.button{display:block;box-sizing:border-box;text-align:center;text-decoration:none;font:inherit;padding:12px;border-radius:10px;background:#0068da;color:white;margin-top:20px}a.button.secondary{background:#eee;color:#222;margin-top:12px}button.button{display:block;width:100%;box-sizing:border-box;font:inherit;padding:12px;border:0;border-radius:10px;background:#0068da;color:white;margin-top:20px;cursor:pointer}button.button.secondary{background:#eee;color:#222;margin-top:12px}";

const formStyle = [
  "label{display:block}button{box-sizing:border-box;font:inherit;width:100%;padding:12px;border:0;border-radius:10px;background:#0068da;color:white;margin-top:12px;cursor:pointer}",
  "button[value=cancel],button.secondary{background:#eee;color:#222}input[type=checkbox],input[type=radio]{margin:0;width:18px;height:18px;flex:none;accent-color:#0068da}",
  ".sites{display:grid;gap:10px;margin:16px 0 20px}.site{border:1px solid #d2d2d7;border-radius:14px;padding:14px 16px}",
  ".site:has(.pick input:checked),.site.fixed{border-color:#0068da;background:#f5f9ff}",
  ".pick{display:flex;align-items:center;gap:12px;cursor:pointer}.name{font-weight:600}.host{color:#6e6e73;font-size:14px;margin-left:auto;text-align:right}",
  ".details{display:grid;gap:10px;margin:12px 0 0 30px}.option{display:flex;align-items:center;gap:10px;cursor:pointer}",
  ".badge{font-size:12px;background:#e3f0ff;color:#0058b9;border-radius:999px;padding:2px 8px;white-space:nowrap}",
  ".key input{box-sizing:border-box;width:100%;font:inherit;padding:10px 12px;border:1px solid #b8b8bd;border-radius:10px;background:white}",
  ".help{display:inline-block;font-size:14px;margin-top:6px}.hint{font-size:14px;color:#555;margin:0}",
  ".status{font-size:13px;color:#555;background:#eee;border-radius:999px;padding:2px 8px;white-space:nowrap}",
  "label.consent{display:flex;gap:10px;align-items:flex-start;margin-top:4px}label.consent input{margin-top:3px}",
  "details.more{margin-top:24px;color:#555;font-size:15px}details.more summary{cursor:pointer;color:#0068da}details.more p{margin:10px 0}.small{font-size:14px;color:#6e6e73}",
  "@media(max-width:520px){body{padding:12px}main{padding:22px;margin:2vh auto}.pick{flex-wrap:wrap;row-gap:2px}.host{width:100%;margin-left:30px;text-align:left}.fixed .host{margin-left:0}.details{margin-left:0}}",
  // Without :has() every site stays open, which still works.
  "@supports selector(:has(*)){.site:not(.fixed):not(:has(.pick input:checked)) .details{display:none}",
  ".site:has(input[value=login]:checked) .key{display:none}.site:has(input[value=key]:checked) .first{display:none}}",
].join("");

/**
 * A short card explaining why connecting stopped and what to do next.
 * `back` reopens the connection form, which stays valid for the interaction's ten minutes,
 * or, as a one-time management token, the connection-management page.
 */
function problemPage(problem: unknown, fallback: string, back?: string | { token: string }) {
  const { title, message, action, steps } = problem instanceof ConnectionProblem ? problem
    : { title: "Galaxy is not connected yet", message: fallback, action: undefined, steps: [] };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${cardStyle}</style>`
    + `<main><h1>${escape(title)}</h1><p>${escape(message)}</p>`
    + (steps.length ? `<ol>${steps.map(step => `<li>${escape(step)}</li>`).join("")}</ol>` : "")
    + (action ? `<a class="button" href="${escape(action.href)}" target="_blank" rel="noopener noreferrer">${escape(action.text)}</a>` : "")
    + (typeof back === "string" ? `<a class="button${action ? " secondary" : ""}" href="${escape(back)}">Back to Connect Galaxy</a>`
      : back ? `<form method="post" action="/connections/action"><input type="hidden" name="action_token" value="${escape(back.token)}"><button class="button${action ? " secondary" : ""}">Back to Manage connections</button></form>` : "")
    + "</main></html>";
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
  const logins = createGalaxyLogins(config.galaxyLogins ?? {}, instances, { allowLoopback: config.allowLoopback === true });
  // Under /interaction/, which the proxy already sends to the broker.
  const loginCallback = `${issuer.origin}/interaction/keycloak/callback`;
  const store = await createStore(config.databaseUrl, config.encryptionKey, logins.refresh);
  const formStore = new store.adapter("LoginForm");
  // A connection in progress while the person signs in to one or more Galaxy sites.
  const signInStore = new store.adapter("GalaxySignIn");
  const managementTicketStore = new store.adapter("ManagementTicket");
  /** The name people know a site by, for the common public servers. */
  const knownSites: Record<string, string> = {
    "https://usegalaxy.org": "Galaxy US", "https://usegalaxy.eu": "Galaxy Europe", "https://usegalaxy.org.au": "Galaxy Australia",
    "https://usegalaxy.fr": "Galaxy France", "https://usegalaxy.ca": "Galaxy Canada", "https://test.galaxyproject.org": "Galaxy test server",
  };
  const siteName = (name: string) => knownSites[instances.get(name) ?? ""] ?? name;
  /**
   * One card per site. Ticking a site opens its card: sites with sign-in offer it first and keep the API key
   * as the other choice; other sites ask for the key with a link to where Galaxy shows it. `fixed` changes one
   * site that is already chosen, so it has no tick box.
   */
  const siteFields = (names: string[], { status = new Map<string, string>(), fixed = false } = {}) => `<div class="sites">${names.map(name => {
    const url = instances.get(name)!;
    const host = escape(new URL(url).host);
    const label = escape(siteName(name));
    const heading = `<span class="name">${label}</span>${status.has(name) ? `<span class="status">${escape(status.get(name)!)}</span>` : ""}<span class="host">${host}</span>`;
    const key = `<div class="key"><input id="key-${escape(name)}" name="api_key.${escape(name)}" type="password" autocomplete="off" maxlength="4096" placeholder="Paste your ${host} API key" aria-label="API key for ${label}">
      <a class="help" href="${escape(url)}/user/api_key" target="_blank" rel="noopener noreferrer">Find your API key on ${host}</a></div>`;
    const choice = logins.has(name)
      ? `<label class="option"><input type="radio" name="method.${escape(name)}" value="login" checked>Sign in with your ${host} account<span class="badge">Recommended</span></label>
        <p class="hint first">Never used Keycloak on ${host}? <a href="${escape(url)}/login/start" target="_blank" rel="noopener noreferrer">Log in there with Keycloak</a> once first, then come back here.</p>
        <label class="option"><input type="radio" name="method.${escape(name)}" value="key">Use an API key instead</label>${key}`
      : key;
    const pick = fixed
      ? `<input type="hidden" name="site.${escape(name)}" value="yes"><div class="pick">${heading}</div>`
      : `<label class="pick"><input type="checkbox" name="site.${escape(name)}" value="yes">${heading}</label>`;
    return `<div class="site${fixed ? " fixed" : ""}">${pick}<div class="details">${choice}</div></div>`;
  }).join("")}</div>`;
  /** Fields a site form may send for each enabled site. */
  const siteFormFields = [...instances.keys()].flatMap(name => [`site.${name}`, `method.${name}`, `api_key.${name}`]);
  /**
   * The ticked sites of a site form, each by API key or sign-in, limited to the sites it offered.
   * A key typed into a site that was then unticked is ignored.
   */
  const readChoices = (form: URLSearchParams, offered: ReadonlySet<string>) => {
    for (const [name, value] of form) {
      if (name.startsWith("site.") && (value !== "yes" || !offered.has(name.slice(5)))) throw new errors.InvalidRequest("Invalid connection.");
    }
    const apiKeys: { instance: string; apiKey: string; baseUrl: string }[] = [];
    const signIns: string[] = [];
    for (const instance of [...offered].sort()) {
      if (form.get(`site.${instance}`) !== "yes") continue;
      const method = logins.has(instance) ? form.get(`method.${instance}`) ?? "login" : "key";
      if (method === "login") { signIns.push(instance); continue; }
      const apiKey = (form.get(`api_key.${instance}`) ?? "").trim();
      if (method !== "key" || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new errors.InvalidRequest("Invalid connection.");
      if (!apiKey) throw new ConnectionProblem(`Paste your API key for ${siteName(instance)}, or untick it.`, "API key missing");
      apiKeys.push({ instance, apiKey, baseUrl: instances.get(instance)! });
    }
    return { apiKeys, signIns };
  };
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
    const interactionCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
    type SignIn = {
      /** The consent interaction being completed, or empty when changing an existing connection from the management page. */
      uid: string;
      manage?: { accountId: string; sourceGrant: string; targetGrant: string };
      apiKeys: { instance: string; apiKey: string; baseUrl: string }[];
      signedIn: { instance: string; baseUrl: string; login: LoginTokens }[];
      users: Record<string, string>;
      remaining: string[];
      step: "authorize" | "returned";
      verifier?: string;
    };
    const continuePage = (target: string, text: string) => {
      ctx.type = "html";
      // Usually replaced at once by the next page; a slow connection shows this card with a manual link.
      ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${escape(target)}"><title>${escape(text)}</title><style>${cardStyle}</style>`
        + `<main><h1>${escape(text)}</h1><p>This should take a moment. If nothing happens, continue here.</p><a class="button" href="${escape(target)}">Continue</a></main></html>`;
    };
    /** Galaxy's own account id for a key or a sign-in's access token. */
    const galaxyUser = async (baseUrl: string, headers: Record<string, string>) => {
      const response = await fetch(`${baseUrl}/api/users/current`, {
        headers: { ...headers, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok && headers.authorization) {
        // Galaxy accepts a sign-in only for an account that has used it on that site before.
        const message = await response.text().catch(() => "");
        if (/at least once/i.test(message)) {
          const host = new URL(baseUrl).host;
          throw new ConnectionProblem(
            `Your Keycloak sign-in worked, but ${host} has not seen this account yet. Galaxy accepts the sign-in only after you have used it on ${host} once.`,
            `Log in to ${host} once`, { href: `${baseUrl}/login/start`, text: `Open ${host}` }, [
              `Open ${host} and choose Keycloak on its login page. A new Galaxy account is created if you do not have one.`,
              `If you already have a ${host} account with a password, log in with it instead, then link Keycloak under User → Preferences → Manage Third-Party Identities.`,
              "Come back to this tab and use the Back button below to try again.",
            ]);
        }
        throw new errors.InvalidRequest("Galaxy identity could not be verified.");
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        const host = new URL(baseUrl).host;
        throw new ConnectionProblem(`${host} did not accept this API key. Copy your key again from User → Preferences → Manage API Key on ${host}; keys from another Galaxy site do not work here.`, "API key not accepted");
      }
      const user = JSON.parse(await identityBody(response)) as { id?: unknown; deleted?: unknown; is_anonymous?: unknown };
      if (typeof user.id !== "string" || !user.id || user.deleted || user.is_anonymous) throw new errors.InvalidRequest("Galaxy identity could not be verified.");
      return user.id;
    };
    /** Sends the browser to the next site's login provider, keeping the connection in progress for ten minutes. */
    const signInNext = async (pending: Omit<SignIn, "step" | "verifier">) => {
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const instance = pending.remaining[0]!;
      const target = await logins.authorizationUrl(instance, {
        state, redirectUri: loginCallback, challenge: createHash("sha256").update(verifier).digest("base64url"),
      });
      await signInStore.upsert(state, { ...pending, step: "authorize", verifier }, 600);
      continuePage(target, `Signing in to ${new URL(instances.get(instance)!).host}…`);
    };
    const managementCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
    const managementError = () => {
      ctx.status = 400;
      ctx.type = "html";
      ctx.body = problemPage(new ConnectionProblem("This connection-management link is invalid, expired or already used. Ask your AI assistant to “manage my Galaxy connections” for a new link.", "This link no longer works"), "");
    };
    const actionToken = async (payload: Record<string, string>) => {
      const token = randomBytes(32).toString("base64url");
      await managementActionStore.upsert(token, payload, 600);
      return token;
    };
    type Managed = { accountId: string; sourceGrant: string };
    type Target = Managed & { targetGrant: string };
    const manageStyle = "body{font:16px system-ui;background:#f5f5f7;color:#1d1d1f;margin:0;padding:32px}main{max-width:720px;margin:5vh auto}header,section,.empty,.notice{background:white;border-radius:24px;padding:28px;margin:16px 0;box-shadow:0 12px 48px #0001}.notice{background:#eaf5ed;color:#175c2e}h1,h2{margin-top:0}p{line-height:1.5;color:#555}ul{list-style:none;padding:0}li{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 0;border-top:1px solid #eee}a{color:#06c;overflow-wrap:anywhere}button{font:inherit;padding:10px 14px;border:0;border-radius:10px;cursor:pointer;background:#0068da;color:white}.secondary{background:#eee;color:#222}.danger{background:#b42318;color:white}.actions{display:flex;gap:8px;flex:none}.status{font-size:13px;color:#555;background:#eee;border-radius:999px;padding:2px 8px;margin-left:6px;white-space:nowrap}.status.warn{background:#fdecc8;color:#7a4a00}.add{margin:4px 0 20px}footer{color:#666;padding:12px 4px}@media(max-width:600px){body{padding:16px}li{align-items:flex-start;flex-direction:column}}";
    const actionButton = (token: string, text: string, className = "") =>
      `<form method="post" action="/connections/action"><input type="hidden" name="action_token" value="${token}"><button${className ? ` class="${className}"` : ""}>${escape(text)}</button></form>`;
    const clientLabelFor = (clientId: string) =>
      // As on the consent page: a Claude metadata URL is shown as its trusted origin.
      clientNames.get(clientId) || (isClaudeMetadataUrl(clientId) ? "claude.ai" : clientId);
    const methodLabel = ({ method, expired }: { method: "key" | "login"; expired: boolean }) =>
      expired ? "Sign-in expired" : method === "login" ? "Signed in with Keycloak" : "API key";
    const renderConnections = async ({ accountId, sourceGrant }: Managed, notice = "") => {
      const credential = await store.managedCredential(accountId, sourceGrant);
      let card = "";
      if (credential) {
        const target = { accountId, sourceGrant, targetGrant: credential.grantId };
        const sites = await Promise.all(credential.connections.map(async connection => {
          const { instance, baseUrl, expired } = connection;
          const change = await actionToken({ ...target, operation: "edit", instance });
          const remove = await actionToken({ ...target, operation: "remove", instance });
          return `<li><div><strong>${escape(siteName(instance))}</strong><span class="status${expired ? " warn" : ""}">${escape(methodLabel(connection))}</span><br><a href="${escape(baseUrl)}" target="_blank" rel="noopener noreferrer">${escape(baseUrl)}</a></div>
            <div class="actions">${actionButton(change, expired ? "Sign in again" : "Change")}${actionButton(remove, "Remove site", "secondary")}</div></li>`;
        }));
        const addable = [...instances.keys()].some(name => !credential.connections.some(value => value.instance === name))
          && credential.connections.length < MAX_CONNECTIONS;
        const add = addable ? actionButton(await actionToken({ ...target, operation: "edit" }), "Add a Galaxy site") : "";
        const revoke = await actionToken({ ...target, operation: "revoke" });
        card = `<section><h2>${escape(clientLabelFor(credential.clientId))}</h2><p>Can browse Galaxy data and run analyses. Expires on ${escape(new Date(credential.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }))}.</p><ul>${sites.join("")}</ul>
          <div class="add">${add}</div>${actionButton(revoke, "Disconnect this client", "danger")}</section>`;
      }
      ctx.set("Referrer-Policy", "same-origin");
      ctx.type = "html";
      ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage Galaxy connections</title>
        <style>${manageStyle}</style>
        <main><header><p>Galaxy MCP</p><h1>Manage connections</h1><p>This page was opened from an active plugin authorization. It does not use a browser login cookie, and API keys are never displayed.</p></header>
        ${notice ? `<div class="notice" role="status">${escape(notice)}</div>` : ""}
        ${card || '<div class="empty"><h2>No active connection</h2><p>This plugin authorization is no longer active. Reconnect Galaxy from your AI client when you want to use it again.</p></div>'}
        <footer><p>Each button is valid once for ten minutes. Use Change to switch a site to another account or a new API key; after creating a new key in Galaxy, delete the old one there. Removing a site or disconnecting does not delete anything in Galaxy.</p></footer></main></html>`;
    };
    /** The form for adding sites to a connection, or for changing how one of its sites is connected. */
    const renderEdit = async (target: Target, instance?: string) => {
      const credential = await store.managedCredential(target.accountId, target.sourceGrant);
      if (!credential || credential.grantId !== target.targetGrant) throw new errors.InvalidRequest("Connection is no longer available.");
      const connected = new Map(credential.connections.map(value => [value.instance, value]));
      const names = instance ? [instance] : [...instances.keys()].filter(name => !connected.has(name));
      if (!names.length || (instance && (!connected.has(instance) || !instances.has(instance)))) throw new errors.InvalidRequest("Nothing to change.");
      const status = new Map(names.flatMap(name => connected.has(name) ? [[name, `Now: ${methodLabel(connected.get(name)!)}`] as const] : []));
      const save = await actionToken({ ...target, operation: "save", sites: names.join(" "), ...(instance ? { instance } : {}) });
      const back = await actionToken({ ...target, operation: "view" });
      const client = clientLabelFor(credential.clientId);
      const title = instance ? `Change ${siteName(instance)}` : "Add a Galaxy site";
      const intro = instance
        ? `${logins.has(instance) ? "Sign in again, or paste an API key" : "Paste a new API key"}; use another account's key or sign-in to switch accounts. Runs being watched on this site stop being watched.`
        : `Tick the sites to add. A connection holds up to ${MAX_CONNECTIONS} sites; this one has ${credential.connections.length}.`;
      ctx.set("Referrer-Policy", "same-origin");
      ctx.type = "html";
      ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
        <style>${cardStyle}${formStyle}</style>
        <main><h1>${escape(title)}</h1><p>${escape(intro)}</p>
        <form method="post" action="/connections/save"><input type="hidden" name="action_token" value="${save}">${siteFields(names, { status, fixed: instance !== undefined })}
        <label class="consent"><input type="checkbox" name="consent" value="yes" required>I allow ${escape(client)} to read my Galaxy data and run analyses on ${instance ? "this site" : "the sites I ticked"}.</label>
        <button>Save</button></form>
        <form method="post" action="/connections/action"><input type="hidden" name="action_token" value="${back}"><button class="secondary">Back to Manage connections</button></form>
        <p class="small">Keys and sign-ins are encrypted and shared only with the Galaxy MCP service, never with the AI client.</p></main></html>`;
    };
    /** Saves verified sites into the connection and shows the management page again. */
    const applyChanges = async (target: Target, connections: Connection[]) => {
      if (!await store.updateConnections(target.accountId, target.targetGrant, connections)) throw new errors.InvalidRequest("Connection is no longer available.");
      await renderConnections(target, connections.length === 1 ? `${siteName(connections[0]!.instance)} updated.` : "Galaxy sites updated.");
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
        ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Galaxy connection management</title><style>${cardStyle}</style><main><h1>Manage Galaxy connections</h1><p>Continue to see and change the Galaxy sites this AI app can use. This private link works once and does not use a browser login cookie.</p><form method="post" action="/connections/start"><input type="hidden" name="ticket" value="${ticketMatch[1]}"><button class="button">Continue</button></form></main></html>`;
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
          await renderConnections({ accountId: saved.accountId, sourceGrant: saved.sourceGrant });
        } else {
          const form = await readForm(ctx.req, new Set(["action_token"]));
          const token = form.get("action_token") || "";
          const saved = await managementActionStore.find(token) as {
            accountId?: unknown; sourceGrant?: unknown; operation?: unknown; targetGrant?: unknown; instance?: unknown;
          } | undefined;
          if (typeof saved?.accountId !== "string" || typeof saved.sourceGrant !== "string" || typeof saved.operation !== "string") throw new errors.InvalidRequest("Invalid management request.");
          await managementActionStore.consume(token);
          const managed = { accountId: saved.accountId, sourceGrant: saved.sourceGrant };
          if (saved.operation === "view") { await renderConnections(managed); return; }
          if (typeof saved.targetGrant !== "string") throw new errors.InvalidRequest("Connection is no longer available.");
          const target = { ...managed, targetGrant: saved.targetGrant };
          const instance = typeof saved.instance === "string" ? saved.instance : undefined;
          if (saved.operation === "edit") { await renderEdit(target, instance); return; }
          const changed = saved.operation === "revoke"
            ? await store.revokeCredential(saved.accountId, saved.targetGrant)
            : saved.operation === "remove" && instance
              ? await store.removeConnection(saved.accountId, saved.targetGrant, instance)
              : false;
          if (!changed) throw new errors.InvalidRequest("Connection is no longer available.");
          await renderConnections(managed, saved.operation === "remove" ? "Galaxy site removed." : "Connection revoked.");
        }
      } catch { managementError(); }
      return;
    }
    if (ctx.path === "/connections/save") {
      ctx.set("Content-Security-Policy", managementCsp);
      let back: { token: string } | undefined;
      try {
        if (ctx.method !== "POST" || ctx.get("origin") !== issuer.origin || !ctx.is("application/x-www-form-urlencoded")
          || !await store.rateLimit(ctx.ip || "unknown")) throw new errors.InvalidRequest("Invalid management request.");
        const form = await readForm(ctx.req, new Set(["action_token", "consent", ...siteFormFields]));
        const token = form.get("action_token") || "";
        const saved = await managementActionStore.find(token) as {
          accountId?: unknown; sourceGrant?: unknown; operation?: unknown; targetGrant?: unknown; sites?: unknown; instance?: unknown;
        } | undefined;
        if (saved?.operation !== "save" || typeof saved.accountId !== "string" || typeof saved.sourceGrant !== "string"
          || typeof saved.targetGrant !== "string" || typeof saved.sites !== "string") throw new errors.InvalidRequest("Invalid management request.");
        await managementActionStore.consume(token);
        const target = { accountId: saved.accountId, sourceGrant: saved.sourceGrant, targetGrant: saved.targetGrant };
        const instance = typeof saved.instance === "string" ? saved.instance : undefined;
        back = { token: await actionToken({ ...target, operation: "edit", ...(instance ? { instance } : {}) }) };
        const { apiKeys, signIns } = readChoices(form, new Set(saved.sites.split(" ")));
        if (form.get("consent") !== "yes" || !apiKeys.length && !signIns.length) {
          throw new ConnectionProblem("Tick a site and allow access before saving.", "Nothing was changed");
        }
        const credential = await store.managedCredential(target.accountId, target.sourceGrant);
        if (!credential || credential.grantId !== target.targetGrant) throw new errors.InvalidRequest("Connection is no longer available.");
        const added = [...apiKeys.map(value => value.instance), ...signIns].filter(name => !credential.connections.some(value => value.instance === name));
        if (credential.connections.length + added.length > MAX_CONNECTIONS) {
          throw new ConnectionProblem(`A connection holds up to ${MAX_CONNECTIONS} sites. Remove a site first, or add fewer.`, "Too many sites");
        }
        // Verify every key before signing in or saving anything.
        const users = Object.fromEntries(await Promise.all(apiKeys.map(async ({ instance: name, baseUrl, apiKey }) =>
          [name, await galaxyUser(baseUrl, { "x-api-key": apiKey })])));
        if (signIns.length) await signInNext({ uid: "", manage: target, apiKeys, signedIn: [], users, remaining: signIns });
        else await applyChanges(target, apiKeys);
      } catch (error) {
        if (!back) { managementError(); return; }
        ctx.status = 400;
        ctx.type = "html";
        ctx.body = problemPage(error, "The change was not saved. Go back to try again.", back);
      }
      return;
    }
    if (ctx.path === "/interaction/keycloak/callback") {
      ctx.set("Content-Security-Policy", interactionCsp);
      let back: string | undefined;
      let manage: Target | undefined;
      try {
        if (ctx.method !== "GET") { ctx.status = 405; return; }
        if (!await store.rateLimit(ctx.ip || "unknown")) { ctx.status = 429; ctx.body = "Too many attempts. Try again later."; return; }
        const params = new URLSearchParams(ctx.querystring);
        const state = params.get("state") || "";
        const pending = await signInStore.find(state) as (SignIn & { consumed?: number }) | undefined;
        if (!pending || pending.consumed || pending.step !== "authorize" || !pending.verifier) throw new errors.InvalidRequest("Invalid sign-in.");
        // Each provider response is used once, whatever happens next.
        await signInStore.consume(state);
        if (pending.manage) manage = pending.manage;
        else back = `/interaction/${encodeURIComponent(pending.uid)}`;
        const instance = pending.remaining[0]!;
        const baseUrl = instances.get(instance)!;
        const code = params.get("code");
        if (!code || params.get("error")) {
          throw new ConnectionProblem(`Signing in to ${new URL(baseUrl).host} was not completed. Go back to try again.`);
        }
        const login = await logins.exchange(instance, { code, verifier: pending.verifier, redirectUri: loginCallback });
        const user = await galaxyUser(baseUrl, { authorization: `Bearer ${login.accessToken}` });
        const next: SignIn = { uid: pending.uid, apiKeys: pending.apiKeys, step: "returned", remaining: pending.remaining.slice(1),
          signedIn: [...pending.signedIn, { instance, baseUrl, login }], users: { ...pending.users, [instance]: user } };
        if (manage) {
          // Management uses no cookie: the one-time state already ties this response to the change being made.
          const progress = { uid: "", manage, apiKeys: next.apiKeys, signedIn: next.signedIn, users: next.users, remaining: next.remaining };
          if (progress.remaining.length) await signInNext(progress);
          else await applyChanges(manage, [...progress.apiKeys, ...progress.signedIn]);
          return;
        }
        const resume = randomBytes(32).toString("base64url");
        await signInStore.upsert(resume, next, 600);
        // The interaction cookie is scoped to the interaction's path, so the same browser has to return there.
        ctx.status = 303;
        ctx.redirect(`${issuer.origin}/interaction/${encodeURIComponent(pending.uid)}/galaxy-login?state=${resume}`);
      } catch (error) {
        ctx.status = 400;
        ctx.type = "html";
        const returnTo = manage ? { token: await actionToken({ ...manage, operation: "view" }) } : back;
        ctx.body = problemPage(error, returnTo ? "Signing in was not completed. Go back to try again." : "Signing in was not completed. Start connecting again from your AI app.", returnTo);
      }
      return;
    }
    const match = /^\/interaction\/([A-Za-z0-9_-]+)(\/galaxy-login)?$/.exec(ctx.path);
    if (match) {
      ctx.set("Content-Security-Policy", interactionCsp);
      let back: string | undefined;
      try {
        if (!["GET", "POST"].includes(ctx.method) || (match[2] && ctx.method !== "GET")) { ctx.status = 405; return; }
        if (!await store.rateLimit(ctx.ip || "unknown")) { ctx.status = 429; ctx.body = "Too many attempts. Try again later."; return; }
        const details = await provider.interactionDetails(ctx.req, ctx.res);
        if (details.uid !== match[1] || !["login", "consent"].includes(details.prompt.name)) throw new errors.InvalidRequest("Invalid interaction.");
        // Once the form has been shown, a failed submission or sign-in can return to it.
        if (ctx.method === "POST" || match[2]) back = `/interaction/${encodeURIComponent(details.uid)}`;
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
          continuePage(returnTo.href, "Finishing your Galaxy connection…");
        };
        /** Saves the complete, verified set of sites as one grant and returns to the AI app. */
        const complete = async (connections: Connection[], users: Record<string, string>) => {
          connections.sort((a, b) => a.instance.localeCompare(b.instance));
          const identities = connections.map(({ instance, baseUrl }) => [baseUrl, users[instance]]);
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
        };
        if (match[2]) {
          // Back from a site's login provider, in the browser that started connecting.
          const state = new URLSearchParams(ctx.querystring).get("state") || "";
          const pending = await signInStore.find(state) as (SignIn & { consumed?: number }) | undefined;
          if (!pending || pending.consumed || pending.step !== "returned" || pending.uid !== details.uid) throw new errors.InvalidRequest("Invalid sign-in.");
          await signInStore.consume(state);
          const progress = { uid: pending.uid, apiKeys: pending.apiKeys, signedIn: pending.signedIn, users: pending.users, remaining: pending.remaining };
          if (progress.remaining.length) await signInNext(progress);
          else await complete([...progress.apiKeys, ...progress.signedIn], progress.users);
          return;
        }
        if (ctx.method === "GET") {
          // Native form POSTs need a non-null Origin; still send no referrer cross-origin.
          ctx.set("Referrer-Policy", "same-origin");
          const csrf = randomBytes(32).toString("base64url");
          await formStore.upsert(csrf, { uid: details.uid }, 600);
          const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(callbackHost);
          const client = escape(clientLabel);
          ctx.type = "html";
          ctx.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Galaxy</title>
            <style>${cardStyle}${formStyle}</style>
            <main><h1>Connect Galaxy</h1><p><strong>${client}</strong> wants to read your Galaxy data and run analyses for you. Tick the Galaxy sites to connect.</p>
            <form method="post" action="/interaction/${escape(details.uid)}"><input type="hidden" name="csrf" value="${csrf}">${siteFields([...instances.keys()])}
            <label class="consent"><input type="checkbox" name="consent" value="yes" required>I allow ${client} to read my Galaxy data and run analyses on the sites I ticked.</label>
            <button name="action" value="connect">Connect Galaxy</button><button name="action" value="cancel" formnovalidate>Cancel</button></form>
            <p class="small">Afterwards you return to <strong>${loopback ? `${client} on this computer (${escape(callbackHost)})` : escape(callbackHost)}</strong>. Keys and sign-ins are encrypted and shared only with the Galaxy MCP service, never with ${client}.</p>
            <details class="more"><summary>More about this connection</summary>
            <p>A connection can include up to ${MAX_CONNECTIONS} sites. Each key belongs to its own site; do not reuse a key on another server.</p>
            <p>Keys and sign-ins are kept for this connection for up to 30 days. Revoking the connection removes them; simply removing an app may not send a revocation request. Your Galaxy accounts and data are not deleted. To immediately disable a key, revoke it in Galaxy.</p>
            <p>Later, ask your connected assistant to “manage my Galaxy connections” to add or remove a site, switch accounts, replace a key or disconnect. It will create a private management link. <a href="/connections">Learn about connection management</a>.</p>
            <p>Missing your Galaxy site? <a href="${escape(new URL("/support#request-site", resource).href)}" target="_blank" rel="noopener noreferrer">Request a site on GitHub</a>. Requests are public and reviewed before a site is enabled. Never post API keys, passwords or private data.</p>
            </details>
            <p class="small">Only connect clients you trust.</p></main></html>`;
          return;
        }
        if (ctx.get("origin") !== issuer.origin || !ctx.is("application/x-www-form-urlencoded")) throw new errors.InvalidRequest("Invalid form origin.");
        const form = await readForm(ctx.req, new Set(["csrf", "consent", "action", ...siteFormFields]));
        const csrf = form.get("csrf") || "";
        if ((await formStore.find(csrf))?.uid !== details.uid) throw new errors.InvalidRequest("Invalid form token.");
        await formStore.consume(csrf);
        if (form.get("action") === "cancel") {
          await finish({ error: "access_denied" });
          return;
        }
        if (form.get("consent") !== "yes" || form.get("action") !== "connect") throw new errors.InvalidRequest("Invalid connection.");
        const { apiKeys, signIns } = readChoices(form, new Set(instances.keys()));
        const sites = apiKeys.length + signIns.length;
        if (!sites) throw new ConnectionProblem("Tick at least one Galaxy site, then connect.", "No site chosen");
        if (sites > MAX_CONNECTIONS) throw new errors.InvalidRequest("Invalid connection.");
        // Verify every key before creating any grant or signing in; a failed site never yields partial consent.
        const users = Object.fromEntries(await Promise.all(apiKeys.map(async ({ instance, baseUrl, apiKey }) =>
          [instance, await galaxyUser(baseUrl, { "x-api-key": apiKey })])));
        if (signIns.length) await signInNext({ uid: details.uid, apiKeys, signedIn: [], users, remaining: signIns });
        else await complete(apiKeys, users);
      } catch (error) {
        ctx.respond = true;
        ctx.status = 400;
        ctx.type = "html";
        ctx.body = problemPage(error, back ? "Connection was not completed. Go back to try again." : "Connection was not completed. Start connecting again from your AI app.", back);
      }
      return;
    }
    await next();
    const oidc = (ctx as KoaContextWithOIDC).oidc;
    if (oidc?.route === "introspection" && ctx.body && typeof ctx.body === "object" && "active" in ctx.body && ctx.body.active === true) {
      const token = oidc.accessToken;
      const credential = token?.grantId ? await store.freshCredential(token.grantId) : undefined;
      const connections = credential && usableConnections(credential.connections);
      // A site whose sign-in ended stays in the grant until the user signs in again from the management page,
      // so the grant remains active, and manageable, even when every site needs signing in again.
      const signInNeeded = credential?.connections.filter(value => "login" in value && value.login.expired) ?? [];
      if (oidc.client?.clientId !== config.resourceClientId || !credential || !token || credential.accountId !== token.accountId
        || credential.clientId !== token.clientId || credential.audience !== token.aud
        || !credential.connections.length || credential.connections.some(value => value.baseUrl !== instances.get(value.instance))) {
        ctx.body = { active: false };
      } else {
        Object.assign(ctx.body, {
          galaxy_connections: connections!.map(value => value.tokenType === "bearer"
            ? { instance: value.instance, access_token: value.apiKey, url: value.baseUrl }
            : { instance: value.instance, api_key: value.apiKey, url: value.baseUrl }),
          ...(signInNeeded.length && { galaxy_sign_in_needed: signInNeeded.map(({ instance, baseUrl }) => ({ instance, url: baseUrl })) }),
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
