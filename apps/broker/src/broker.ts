import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { Provider, errors, interactionPolicy, type ClientMetadata, type KoaContextWithOIDC, type JWKS } from "oidc-provider";

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

async function readForm(req: IncomingMessage, instances: Map<string, string>) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65536) throw new errors.InvalidRequest("Form is too large.");
    chunks.push(buffer);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const allowed = new Set(["csrf", "instance", "api_key", "consent", "action", ...[...instances.keys()].map(name => `api_key.${name}`)]);
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
  if (!config.clients.length || config.clients.some((client) => client.client_id === config.resourceClientId)) {
    throw new Error("Configure distinct application and resource-server clients.");
  }
  for (const client of config.clients) {
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
        ...config.clients.map((client): ClientMetadata => ({
          ...client, response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"], scope: "galaxy:full offline_access openid",
        })),
        { client_id: config.resourceClientId, client_secret: config.resourceClientSecret,
          response_types: [], grant_types: [], token_endpoint_auth_method: "client_secret_basic" },
      ],
      jwks: config.jwks,
      discovery: { introspection_endpoint_auth_methods_supported: ["client_secret_basic"] },
      cookies: {
        keys: config.cookieKeys,
        long: { httpOnly: true, sameSite: "lax", secure: issuer.protocol === "https:" },
        short: { httpOnly: true, sameSite: "lax", secure: issuer.protocol === "https:" },
      },
      interactions: { policy },
      pkce: { required: () => true },
      scopes: ["galaxy:full", "offline_access"],
      features: {
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
            <main><h1>Connect Galaxy</h1><p><strong>${escape(client.clientName || clientId)}</strong> requests access to the Galaxy accounts you select below.</p>
            <form method="post" action="/interaction/${escape(details.uid)}"><input type="hidden" name="csrf" value="${csrf}">
            <p>Choose from the ${instances.size} enabled Galaxy sites below. Enter your own API key only for each site you want to authorize; leave other fields blank. Each connection can include up to 10 sites. Keys belong to their individual servers; do not reuse a key on another server.</p>${fields}
            <p>Your keys are encrypted and kept for this connection for up to 30 days. They are shared only with the Galaxy MCP service, never with the AI client. Revoking this connection removes all its saved keys; simply removing an app may not send a revocation request. Your Galaxy accounts and data are not deleted. To add or remove a server, reconnect with the desired set; existing authorizations are not expanded.</p>
            <label><input type="checkbox" name="consent" value="yes" required>I allow this client to read my Galaxy data and run analyses on every server for which I entered a key.</label>
            <button name="action" value="connect">Connect Galaxy</button><button name="action" value="cancel" formnovalidate>Cancel</button></form>
            <p>Missing your Galaxy site? <a href="${escape(new URL("/support#request-site", resource).href)}" target="_blank" rel="noopener noreferrer">Request a site on GitHub</a>. Requests are public and reviewed before a site is enabled. Never post API keys, passwords or private data.</p>
            <small>Only connect clients you trust. To immediately disable all use of this Galaxy key, revoke it in Galaxy.</small></main></html>`;
          return;
        }
        if (ctx.get("origin") !== issuer.origin || !ctx.is("application/x-www-form-urlencoded")) throw new errors.InvalidRequest("Invalid form origin.");
        const form = await readForm(ctx.req, instances);
        const csrf = form.get("csrf") || "";
        if ((await formStore.find(csrf))?.uid !== details.uid) throw new errors.InvalidRequest("Invalid form token.");
        await formStore.consume(csrf);
        if (form.get("action") === "cancel") {
          await finish({ error: "access_denied" });
          return;
        }
        const legacy = form.has("instance") || form.has("api_key");
        if (legacy && [...form.keys()].some(name => name.startsWith("api_key."))) throw new errors.InvalidRequest("Mixed connection formats.");
        const selected = legacy ? [[form.get("instance") || "", form.get("api_key") || ""]]
          : [...form].filter(([name, key]) => name.startsWith("api_key.") && key).map(([name, key]) => [name.slice(8), key]);
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
        const accountId = createHash("sha256").update(JSON.stringify(identities.length === 1 ? identities[0] : identities)).digest("base64url");
        const grant = new provider.Grant({ accountId, clientId });
        grant.exp = Math.floor(Date.now() / 1000) + lifetime;
        grant.addResourceScope(resource, "galaxy:full");
        grant.addOIDCScope("galaxy:full offline_access openid");
        const grantId = await grant.save();
        try {
          await store.saveCredential(grantId, { accountId, clientId, audience: resource, ...connections[0]!,
            ...(connections.length > 1 && { connections }),
          }, grant.exp! * 1000);
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
      const connections = credential && (credential.connections ?? [credential]);
      if (oidc.client?.clientId !== config.resourceClientId || !credential || !token || credential.accountId !== token.accountId
        || credential.clientId !== token.clientId || credential.audience !== token.aud
        || !connections?.length || connections.some(value => value.baseUrl !== instances.get(value.instance))) {
        ctx.body = { active: false };
      } else {
        // Older single-site services must reject a bundle, never silently use its first key.
        Object.assign(ctx.body, credential.connections ? {
          galaxy_connections: connections.map(value => ({ instance: value.instance, api_key: value.apiKey, url: value.baseUrl })),
        } : { galaxy_instance: credential.instance, galaxy_api_key: credential.apiKey, galaxy_url: credential.baseUrl });
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
