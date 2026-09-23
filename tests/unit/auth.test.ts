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

function load(overrides: Record<string, unknown> = {}, audience = resource, tokenOverrides: Record<string, unknown> = {}) {
  return loadUniversalAuth({
    metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
    resourceServerUrl: resource,
    introspectionClientId: "fixture-client",
    introspectionClientSecret: "fixture-secret",
    instancesJson: '{"main":"https://galaxy.example.test","eu":"https://eu.example.test"}',
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
        ...tokenOverrides,
      });
    },
  });
}

describe("OAuth provider compatibility", () => {
  it("accepts a complete bundle without exposing a default key, and rejects ambiguous or invalid bundles", async () => {
    const connections = [
      { instance: "main", api_key: "main-key", url: "https://galaxy.example.test" },
      { instance: "eu", api_key: "eu-key", url: "https://eu.example.test" },
    ];
    const bundle = { galaxy_instance: undefined, galaxy_api_key: undefined, galaxy_connections: connections };
    const auth = await load({}, resource, bundle);
    const verified = await auth.verifier.verifyAccessToken("bundle-token");
    expect(verified.extra?.galaxy).toBeUndefined();
    expect(verified.extra?.galaxies).toMatchObject(connections.map(value => ({ instance: value.instance, baseUrl: value.url, apiKey: value.api_key })));
    for (const overrides of [
      { galaxy_connections: [] }, { galaxy_connections: [...connections, connections[0]] },
      { galaxy_instance: "main" }, { galaxy_api_key: "main-key" }, { galaxy_url: "https://galaxy.example.test" },
      { galaxy_connections: [{ ...connections[0], instance: "unknown" }] },
      { galaxy_connections: [{ ...connections[1], url: "https://attacker.example.test" }] },
      { galaxy_connections: [{ ...connections[1], api_key: "" }] },
      { galaxy_connections: [{ instance: "eu", api_key: "eu-key" }] },
      { galaxy_connections: undefined },
    ]) {
      const invalid = await load({}, resource, { ...bundle, ...overrides });
      await expect(invalid.verifier.verifyAccessToken("bundle-token")).rejects.toThrow();
    }
  });
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

  it("rejects broker/resource instance mapping disagreement before forwarding a credential", async () => {
    const matching = await load({}, resource, { galaxy_url: "https://galaxy.example.test" });
    expect(await matching.verifier.verifyAccessToken("fixture-token")).toMatchObject({
      extra: { galaxy: { baseUrl: "https://galaxy.example.test" } },
    });
    const remapped = await load({}, resource, { galaxy_url: "https://different.example.test" });
    await expect(remapped.verifier.verifyAccessToken("fixture-token")).rejects.toThrow("not valid for this service");
  });
});
