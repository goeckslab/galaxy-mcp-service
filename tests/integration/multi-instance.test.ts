import { expect, it } from "vitest";
import { loadUniversalAuth } from "../../apps/service/src/auth.js";
import { modernRequest, startTestService } from "../helpers/service.js";

it("routes one authorization concurrently across sites with identical handles and no fallback or credential disclosure", async () => {
  const issuer = "https://auth.example.test";
  const resource = "http://127.0.0.1/mcp";
  const calls: Request[] = [];
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const instances = { us: "https://us.example.test", eu: "https://eu.example.test/galaxy" };
  const auth = await loadUniversalAuth({
    metadataUrl: `${issuer}/.well-known/oauth-authorization-server`, resourceServerUrl: resource,
    introspectionClientId: "resource", introspectionClientSecret: "fixture-secret", instancesJson: JSON.stringify(instances),
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === issuer) {
        if (request.method === "GET") return Response.json({
          issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, introspection_endpoint: `${issuer}/introspect`,
          introspection_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"], scopes_supported: ["galaxy:full"], token_endpoint_auth_methods_supported: ["none"],
        });
        return Response.json({ active: true, iss: issuer, aud: resource, sub: "bundle-owner", client_id: "client",
          exp: Math.floor(Date.now() / 1000) + 600, scope: "galaxy:full",
          galaxy_connections: Object.entries(instances).map(([instance, url]) => ({ instance, url, api_key: `fixture-${instance}-key` })),
        });
      }
      calls.push(request);
      const site = url.host === "us.example.test" ? "us" : "eu";
      expect(url.href.startsWith(instances[site] + "/api/")).toBe(true);
      expect(request.headers.get("x-api-key")).toBe(`fixture-${site}-key`);
      expect(request.redirect).toBe("error");
      const dataset = { id: "d1", name: `${site} report`, state: "ok", file_ext: "html", extension: "html", history_content_type: "dataset" };
      if (url.pathname.endsWith("/api/histories")) return Response.json(request.method === "POST"
        ? { id: "h1", name: `${site} created history` } : [{ id: "h1", name: `${site} history`, state: "ok" }]);
      if (url.pathname.endsWith("/api/histories/h1/contents")) return Response.json([dataset]);
      if (url.pathname.endsWith("/api/datasets/d1/display")) return new Response(`<h1>${site} findings</h1><img src="data:image/png;base64,${png}">`);
      if (url.pathname.endsWith("/api/datasets/t1/display")) return new Response(`${site} numerical evidence`);
      if (url.pathname.endsWith("/api/datasets/d1/get_content_as_text")) return Response.json({ item_data: `<h1>${site} findings</h1>`, truncated: false });
      if (url.pathname.endsWith("/api/datasets/t1/get_content_as_text")) return Response.json({ item_data: `${site} numerical evidence`, truncated: false });
      if (url.pathname.endsWith("/api/datasets/d1")) return Response.json(dataset);
      if (url.pathname.endsWith("/api/datasets/t1")) return Response.json({ ...dataset, id: "t1", file_ext: "txt", extension: "txt" });
      if (url.pathname.endsWith("/api/tool_requests/r1")) return Response.json({ state: "submitted", jobs: [{ id: "j1" }], implicit_collections: [] });
      if (url.pathname.endsWith("/api/jobs/j1")) return Response.json({ id: "j1", state: site === "us" ? "ok" : "running", history_id: "h1" });
      throw new Error(`Unexpected fixture route: ${url.pathname}`);
    },
  });
  const service = await startTestService({ auth });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const request = modernRequest("tools/call", { name, arguments: args });
    request.headers.set("authorization", "Bearer fixture-bundle-token");
    const response = await fetch(`${service.baseUrl}/mcp`, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.error).toBeUndefined();
    expect(JSON.stringify(value)).not.toMatch(/fixture-(us|eu)-key|fixture-bundle-token/);
    return value.result;
  };
  try {
    expect((await call("get_galaxy_connections")).structuredContent.connections).toEqual(Object.entries(instances).map(([instance, url]) => ({ instance, url })));
    const routes: [string, Record<string, unknown>][] = [
      ["get_histories", {}], ["get_history_contents", { historyId: "h1" }], ["show_dataset", { datasetId: "d1" }],
      ["get_dataset_html", { datasetId: "d1" }], ["get_dataset_text", { datasetId: "t1" }],
      ["read_dataset_report", { datasetId: "d1", includeImage: true }], ["get_run_status", { kind: "tool", runId: "r1" }],
      ["create_history", { historyName: "Requested history" }],
    ];
    for (const [name, args] of routes) {
      for (const selector of [{}, { instance: "unknown" }, { instance: instances.eu }]) {
        const before = calls.length;
        const rejected = await call(name, { ...args, ...selector });
        expect(rejected.isError).toBe(true);
        expect(rejected.content[0].text).toContain("No Galaxy request was sent");
        expect(calls).toHaveLength(before);
      }
      const pair = await Promise.all(Object.entries(instances).map(async ([instance, url]) => {
        const result = await call(name, { ...args, instance });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent.galaxy).toEqual({ instance, url });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        if (name === "read_dataset_report") expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: png });
        if (name === "get_dataset_html") expect(result._meta.html).toContain(`${instance} findings`);
        return result.structuredContent;
      }));
      if (name === "get_histories") expect(pair.map(value => value.histories[0].name)).toEqual(["us history", "eu history"]);
      if (name === "get_run_status") expect(pair.map(value => value.run.state)).toEqual(["completed", "running"]);
      if (name === "get_dataset_text") expect(pair.map(value => value.text)).toEqual(["us numerical evidence", "eu numerical evidence"]);
    }
    expect(service.logs.join("\n")).not.toMatch(/fixture-(us|eu)-key|fixture-bundle-token/);
  } finally { await service.stop(); }
});
