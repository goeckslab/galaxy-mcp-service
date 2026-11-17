import { z } from "zod";

/** A Galaxy site whose users can sign in through an OpenID provider (such as auth.usegalaxy.org) instead of pasting an API key. */
export interface GalaxyLoginConfig {
  issuer: string;
  client_id: string;
  client_secret: string;
  /** Requested in addition to openid. */
  scope?: string | undefined;
}

export interface LoginTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** The provider no longer honours the sign-in, so the user has to sign in again. */
export class LoginExpired extends Error {}

const configSchema = z.record(z.string(), z.object({
  issuer: z.string().url(),
  client_id: z.string().min(1).max(256),
  client_secret: z.string().min(16).max(4096),
  scope: z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/).optional(),
}).strict());

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
}).passthrough();

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).max(16384),
}).passthrough();

function secureUrl(value: string, allowLoopback: boolean) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
    || url.username || url.password || url.hash) {
    throw new Error("Galaxy sign-in URLs must use HTTPS without credentials or a fragment.");
  }
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 65536) throw new Error("Galaxy sign-in response is too large.");
  return JSON.parse(text);
}

export function parseGalaxyLogins(raw: string | undefined): Record<string, GalaxyLoginConfig> {
  if (!raw) return {};
  return configSchema.parse(JSON.parse(raw));
}

export function createGalaxyLogins(
  config: Record<string, GalaxyLoginConfig>, instances: ReadonlyMap<string, string>,
  { allowLoopback = false, fetchImpl = fetch }: { allowLoopback?: boolean; fetchImpl?: typeof fetch } = {},
) {
  const sites = new Map(Object.entries(configSchema.parse(config)).map(([instance, value]) => {
    if (!instances.has(instance)) throw new Error("Galaxy sign-in is configured for a site that is not enabled.");
    return [instance, { ...value, issuer: secureUrl(value.issuer, allowLoopback).href.replace(/\/$/, "") }];
  }));
  // Discovered on first use, so a provider outage never stops the broker from starting.
  const discovered = new Map<string, Promise<z.infer<typeof discoverySchema>>>();
  function discover(instance: string) {
    const site = sites.get(instance);
    if (!site) return Promise.reject(new Error("Galaxy sign-in is not configured for this site."));
    let pending = discovered.get(instance);
    if (!pending) {
      pending = (async () => {
        const response = await fetchImpl(`${site.issuer}/.well-known/openid-configuration`, {
          headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Galaxy sign-in provider is unavailable.");
        const metadata = discoverySchema.parse(await boundedJson(response));
        if (metadata.issuer.replace(/\/$/, "") !== site.issuer
          || (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256"))) {
          throw new Error("Galaxy sign-in provider metadata does not match its configuration.");
        }
        secureUrl(metadata.authorization_endpoint, allowLoopback);
        secureUrl(metadata.token_endpoint, allowLoopback);
        return metadata;
      })();
      pending.catch(() => discovered.delete(instance));
      discovered.set(instance, pending);
    }
    return pending;
  }
  async function token(instance: string, form: Record<string, string>): Promise<LoginTokens> {
    const site = sites.get(instance)!;
    const metadata = await discover(instance);
    const credential = (value: string) => encodeURIComponent(value);
    const response = await fetchImpl(metadata.token_endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: {
        accept: "application/json", "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${credential(site.client_id)}:${credential(site.client_secret)}`).toString("base64")}`,
      },
      body: new URLSearchParams(form),
    });
    const body = await boundedJson(response).catch(() => undefined) as { error?: unknown } | undefined;
    if (!response.ok) {
      if (response.status === 400 && body?.error === "invalid_grant") throw new LoginExpired("Galaxy sign-in is no longer valid.");
      throw new Error("Galaxy sign-in provider did not answer.");
    }
    const parsed = tokenSchema.parse(body);
    return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token, expiresAt: Date.now() + parsed.expires_in * 1000 };
  }
  return {
    has: (instance: string) => sites.has(instance),
    async authorizationUrl(instance: string, values: { state: string; challenge: string; redirectUri: string }) {
      const site = sites.get(instance)!;
      const url = new URL((await discover(instance)).authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code", client_id: site.client_id, redirect_uri: values.redirectUri,
        scope: ["openid", ...(site.scope ? [site.scope] : [])].join(" "),
        state: values.state, code_challenge: values.challenge, code_challenge_method: "S256",
      }).toString();
      return url.href;
    },
    exchange: (instance: string, values: { code: string; verifier: string; redirectUri: string }) => token(instance, {
      grant_type: "authorization_code", code: values.code, code_verifier: values.verifier, redirect_uri: values.redirectUri,
    }),
    refresh: (instance: string, refreshToken: string) => token(instance, { grant_type: "refresh_token", refresh_token: refreshToken }),
  };
}

export type GalaxyLogins = ReturnType<typeof createGalaxyLogins>;
