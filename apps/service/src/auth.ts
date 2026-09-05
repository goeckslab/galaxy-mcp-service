import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export const GALAXY_SCOPE = "galaxy:full";

export interface UniversalAuth {
  oauthMetadata: OAuthMetadata;
  resourceServerUrl: URL;
  scopes: string[];
  verifier: OAuthTokenVerifier;
}

interface UniversalAuthConfig {
  metadataUrl: string;
  introspectionClientId: string;
  introspectionClientSecret: string;
  instancesJson: string;
  resourceServerUrl: string;
  fetchImpl?: typeof fetch;
}

const metadataSchema = z
  .object({
    issuer: z.string().min(1),
    authorization_endpoint: z.string().min(1),
    client_id_metadata_document_supported: z.boolean().optional(),
    token_endpoint: z.string().min(1),
    introspection_endpoint: z.string().min(1),
    introspection_endpoint_auth_methods_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
    response_types_supported: z.array(z.string()),
    scopes_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()),
  })
  .passthrough();

const activeTokenSchema = z
  .object({
    active: z.literal(true),
    aud: z.union([z.string(), z.array(z.string())]),
    client_id: z.string().min(1),
    exp: z.number().int(),
    galaxy_api_key: z.string().min(1),
    galaxy_instance: z.string().min(1),
    iss: z.string().min(1),
    scope: z.union([z.string(), z.array(z.string())]),
    sub: z.string().min(1),
  })
  .passthrough();

function secureUrl(value: string, label: string, allowLocalHttp = false): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowLocalHttp && url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(`${label} must be an HTTPS URL without credentials or a fragment`);
  }
  return url;
}

function galaxyInstances(raw: string): Map<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("GALAXY_INSTANCES_JSON must be a JSON object");
  }
  const parsed = z.record(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), z.string().min(1)).safeParse(value);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    throw new Error("GALAXY_INSTANCES_JSON must map at least one instance id to a Galaxy URL");
  }
  return new Map(
    Object.entries(parsed.data).map(([id, value]) => {
      const url = secureUrl(value, `Galaxy instance ${id}`, true);
      if (url.search) throw new Error(`Galaxy instance ${id} must not include a query`);
      return [id, url.toString().replace(/\/$/, "")];
    }),
  );
}

function basicCredential(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

export async function loadUniversalAuth(config: UniversalAuthConfig): Promise<UniversalAuth> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const metadataUrl = secureUrl(config.metadataUrl, "OAUTH_METADATA_URL", true);
  const resourceServerUrl = secureUrl(config.resourceServerUrl, "Universal MCP resource", true);
  const instances = galaxyInstances(config.instancesJson);

  const metadataResponse = await fetchImpl(metadataUrl, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!metadataResponse.ok) throw new Error("OAuth metadata could not be loaded");
  const metadata = metadataSchema.safeParse(await metadataResponse.json());
  if (!metadata.success) throw new Error("OAuth metadata is incomplete");
  if (!metadata.data.code_challenge_methods_supported.includes("S256")) {
    throw new Error("OAuth metadata must advertise PKCE S256");
  }
  if (!metadata.data.response_types_supported.includes("code")) {
    throw new Error("OAuth metadata must advertise the authorization code response type");
  }
  // The connector can use CIMD, dynamic registration, or a pre-registered client.
  if (!metadata.data.token_endpoint_auth_methods_supported.some((method) =>
    ["none", "private_key_jwt", "client_secret_basic", "client_secret_post"].includes(method))) {
    throw new Error("OAuth metadata must advertise a ChatGPT-compatible token endpoint authentication method");
  }
  if (!metadata.data.introspection_endpoint_auth_methods_supported.includes("client_secret_basic")) {
    throw new Error("OAuth introspection must support client_secret_basic");
  }
  if (!metadata.data.scopes_supported.includes(GALAXY_SCOPE)) {
    throw new Error(`OAuth metadata must advertise ${GALAXY_SCOPE}`);
  }
  secureUrl(metadata.data.issuer, "OAuth issuer", true);
  secureUrl(metadata.data.authorization_endpoint, "OAuth authorization endpoint", true);
  secureUrl(metadata.data.token_endpoint, "OAuth token endpoint", true);
  const introspectionUrl = secureUrl(metadata.data.introspection_endpoint, "OAuth introspection endpoint", true);

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let response: Response;
      try {
        response = await fetchImpl(introspectionUrl, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Basic ${Buffer.from(
              `${basicCredential(config.introspectionClientId)}:${basicCredential(config.introspectionClientSecret)}`,
            ).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ token, token_type_hint: "access_token" }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new OAuthError(OAuthErrorCode.ServerError, "The authorization server is unavailable.");
      }
      if (!response.ok) {
        throw new OAuthError(OAuthErrorCode.ServerError, "Token introspection failed.");
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new OAuthError(OAuthErrorCode.ServerError, "Token introspection returned invalid JSON.");
      }
      if (z.object({ active: z.boolean() }).passthrough().safeParse(payload).data?.active !== true) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is inactive.");
      }
      const parsed = activeTokenSchema.safeParse(payload);
      if (!parsed.success) throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is incomplete.");

      const scopes = Array.isArray(parsed.data.scope)
        ? parsed.data.scope
        : parsed.data.scope.split(/\s+/).filter(Boolean);
      const audiences = Array.isArray(parsed.data.aud) ? parsed.data.aud : [parsed.data.aud];
      const baseUrl = instances.get(parsed.data.galaxy_instance);
      if (
        parsed.data.iss !== metadata.data.issuer ||
        !audiences.includes(resourceServerUrl.href) ||
        parsed.data.exp <= Date.now() / 1000 ||
        baseUrl === undefined
      ) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is not valid for this service.");
      }

      return {
        token,
        clientId: parsed.data.client_id,
        scopes,
        expiresAt: parsed.data.exp,
        resource: resourceServerUrl,
        extra: {
          subject: parsed.data.sub,
          galaxy: { baseUrl, apiKey: parsed.data.galaxy_api_key, fetchImpl },
        },
      };
    },
  };

  return {
    oauthMetadata: metadata.data as OAuthMetadata,
    resourceServerUrl,
    scopes: [GALAXY_SCOPE],
    verifier,
  };
}
