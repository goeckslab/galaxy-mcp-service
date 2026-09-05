import { describe, expect, it } from "vitest";

import { loadUniversalAuth } from "../../apps/service/src/auth.js";

const issuer = "https://auth.example.test";
const resource = "https://mcp.example.test/mcp";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  introspection_endpoint: `${issuer}/introspect`,
  introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
  code_challenge_methods_supported: ["S256"],
  response_types_supported: ["code"],
  scopes_supported: ["galaxy:full"],
  token_endpoint_auth_methods_supported: ["none"],
};

function load(overrides: Record<string, unknown> = {}, audience = resource) {
  return loadUniversalAuth({
    metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
    resourceServerUrl: resource,
    introspectionClientId: "fixture-client",
    introspectionClientSecret: "fixture-secret",
    instancesJson: '{"main":"https://galaxy.example.test"}',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("error");
      if (request.method === "GET") return Response.json({ ...metadata, ...overrides });
      expect(request.url).toBe(`${issuer}/introspect`);
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("fixture-client:fixture-secret").toString("base64")}`);
      return Response.json({
        active: true,
        aud: audience,
        iss: issuer,
        sub: "fixture-user",
        client_id: "chatgpt-fixture",
        exp: Math.floor(Date.now() / 1000) + 60,
        scope: "galaxy:full",
        galaxy_instance: "main",
        galaxy_api_key: "fixture-api-key",
      });
    },
  });
}

describe("OAuth provider compatibility", () => {
  it.each([
    ["CIMD public client", { client_id_metadata_document_supported: true }],
    ["DCR confidential client", {
      registration_endpoint: `${issuer}/register`,
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    }],
    ["pre-registered confidential client", { token_endpoint_auth_methods_supported: ["client_secret_post"] }],
    ["CIMD with additional methods", {
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic", "tls_client_auth"],
    }],
    ["DCR alongside CIMD advertisement", {
      client_id_metadata_document_supported: true,
      registration_endpoint: `${issuer}/register`,
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    }],
  ])("accepts %s without weakening introspection", async (_label, overrides) => {
    const auth = await load(overrides as Record<string, unknown>);
    expect(auth.scopes).toEqual(["galaxy:full"]);
    expect(await auth.verifier.verifyAccessToken("fixture-token")).toMatchObject({
      clientId: "chatgpt-fixture",
      extra: { subject: "fixture-user", galaxy: { baseUrl: "https://galaxy.example.test" } },
    });
  });

  it.each([
    [{ code_challenge_methods_supported: ["plain"] }, "PKCE S256"],
    [{ response_types_supported: ["token"] }, "authorization code"],
    [{ scopes_supported: ["openid"] }, "galaxy:full"],
    [{ introspection_endpoint_auth_methods_supported: ["client_secret_post"] }, "introspection must support client_secret_basic"],
    [{ token_endpoint_auth_methods_supported: ["tls_client_auth"] }, "ChatGPT-compatible"],
  ])("retains the required provider checks for %j", async (overrides, message) => {
    await expect(load(overrides)).rejects.toThrow(message);
  });

  it("still rejects introspected tokens issued for another resource", async () => {
    const auth = await load({}, "https://other.example.test/mcp");
    await expect(auth.verifier.verifyAccessToken("fixture-token")).rejects.toThrow("not valid for this service");
  });
});
