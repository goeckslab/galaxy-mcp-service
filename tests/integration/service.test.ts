import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadUniversalAuth } from "../../apps/service/src/auth.js";
import { productOperations } from "../../apps/service/src/mcp.js";
import { HISTORY_SUMMARY_URI } from "../../apps/service/src/history-summary-ui.js";
import { modernRequest, postModern, startTestService } from "../helpers/service.js";

let baseUrl: string;
let logs: string[];
let stop: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const service = await startTestService();
  baseUrl = service.baseUrl;
  logs = service.logs;
  stop = service.stop;
});

afterAll(async () => stop());

describe("HTTP MCP service", () => {
  it("serves health and readiness", async () => {
    expect(await (await fetch(`${baseUrl}/healthz`)).json()).toEqual({ status: "ok" });
    expect(await (await fetch(`${baseUrl}/readyz`)).json()).toEqual({ status: "ready" });
  });

  it("routes Universal OAuth users to their allowlisted Galaxy instance", async () => {
    const resource = "http://127.0.0.1/mcp";
    const issuer = "https://auth.example.test";
    const introspectionUrl = `${issuer}/oauth/introspect`;
    const brokerSecret = "integration-broker-secret";
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.redirect).toBe("error");
      calls.push(`${request.method} ${url.host}${url.pathname}`);

      if (request.method === "GET" && url.href === `${issuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          client_id_metadata_document_supported: true,
          token_endpoint: `${issuer}/oauth/token`,
          introspection_endpoint: introspectionUrl,
          introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
          scopes_supported: ["galaxy:full"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (request.method === "POST" && url.href === introspectionUrl) {
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from(`broker-client:${brokerSecret}`).toString("base64")}`,
        );
        const token = new URLSearchParams(await request.text()).get("token");
        if (token === "inactive") return Response.json({ active: false });
        const instance = token === "token-eu" ? "eu" : token === "token-unknown" ? "unknown" : "us";
        return Response.json({
          active: true,
          aud: token === "wrong-audience" ? "https://other.example.test/mcp" : resource,
          client_id: "chatgpt",
          exp: Math.floor(Date.now() / 1000) + (token === "expired" ? -60 : 60),
          galaxy_api_key: `key-${instance}`,
          galaxy_instance: instance,
          iss: issuer,
          scope: token === "missing-scope" ? "profile" : "galaxy:full",
          sub: `user-${instance}`,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/histories" && ["us.example.test", "eu.example.test"].includes(url.host)) {
        const instance = url.host.startsWith("us") ? "us" : "eu";
        expect(request.headers.get("x-api-key")).toBe(`key-${instance}`);
        return Response.json([{ id: `h-${instance}`, name: `${instance.toUpperCase()} history`, state: "ok" }]);
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    };
    const auth = await loadUniversalAuth({
      metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
      introspectionClientId: "broker-client",
      introspectionClientSecret: brokerSecret,
      instancesJson: JSON.stringify({ us: "https://us.example.test", eu: "https://eu.example.test" }),
      resourceServerUrl: resource,
      fetchImpl,
    });
    await expect(
      startTestService({
        auth,
        galaxy: { baseUrl: "https://shared.example.test", apiKey: "shared-key" },
        publicBaseUrl: "http://127.0.0.1",
      }),
    ).rejects.toThrow("cannot use a shared Galaxy connection");
    const configured = await startTestService({ auth, publicBaseUrl: "http://127.0.0.1" });
    try {
      const unauthenticated = modernRequest("server/discover");
      const challenge = await fetch(`${configured.baseUrl}/mcp`, {
        method: "POST",
        headers: unauthenticated.headers,
        body: JSON.stringify(unauthenticated.body),
      });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toContain(
        'resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
      );

      const metadata = await (await fetch(`${configured.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(metadata).toMatchObject({
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["galaxy:full"],
      });

      for (const instance of ["us", "eu"]) {
        const request = modernRequest("tools/call", {
          name: "get_histories",
          arguments: { limit: 1 },
        });
        request.headers.set("authorization", `Bearer token-${instance}`);
        const response = await fetch(`${configured.baseUrl}/mcp`, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
        });
        const payload = (await response.json()) as {
          result: { structuredContent: { instance: string; histories: Array<{ id: string }> } };
        };
        expect(response.status).toBe(200);
        expect(payload.result.structuredContent).toMatchObject({
          instance: `${instance}.example.test`,
          histories: [{ id: `h-${instance}` }],
        });
      }

      for (const [token, status] of [
        ["inactive", 401],
        ["token-unknown", 401],
        ["wrong-audience", 401],
        ["expired", 401],
        ["missing-scope", 403],
      ] as const) {
        const invalid = modernRequest("server/discover");
        invalid.headers.set("authorization", `Bearer ${token}`);
        expect(
          await fetch(`${configured.baseUrl}/mcp`, {
            method: "POST",
            headers: invalid.headers,
            body: JSON.stringify(invalid.body),
          }),
        ).toMatchObject({ status });
      }
      expect(configured.logs.join("\n")).not.toMatch(
        /key-us|key-eu|integration-broker-secret|token-us|token-eu|token-unknown|wrong-audience|missing-scope/,
      );
      expect(calls.filter((call) => call.includes("/api/histories"))).toEqual([
        "GET us.example.test/api/histories",
        "GET eu.example.test/api/histories",
      ]);
      expect(calls.filter((call) => call.endsWith("/oauth/introspect"))).toHaveLength(7);
      expect(calls[0]).toBe(
        "GET auth.example.test/.well-known/oauth-authorization-server",
      );
    } finally {
      await configured.stop();
    }
  });

  it("supports modern discovery and automatic SDK negotiation", async () => {
    const discovery = await postModern(baseUrl, "server/discover");
    expect(discovery.status).toBe(200);
    expect((await discovery.json()) as object).toHaveProperty(
      ["result", "_meta", "io.modelcontextprotocol/serverInfo", "name"],
      "galaxy-mcp-service",
    );

    const client = new Client(
      { name: "integration-client", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "get_histories",
      ...productOperations.map(({ name }) => name),
      "get_run_status",
      "get_dataset_text",
      "get_dataset_html",
    ]);
    const unconfigured = await client.callTool({ name: "search_tools_by_name", arguments: { query: "fastqc" } });
    expect(unconfigured.structuredContent).toMatchObject({ success: false, errorKind: "connection" });
    expect(unconfigured.isError).toBe(true);
    const unconfiguredRun = await client.callTool({ name: "get_run_status", arguments: { kind: "tool", runId: "r1" } });
    expect(unconfiguredRun).toMatchObject({ isError: true, structuredContent: { success: false, run: { kind: "tool", id: "r1", state: "unknown" } } });
    const unconfiguredHistory = await client.callTool({ name: "get_history_details", arguments: { historyId: "h1" } });
    expect(unconfiguredHistory).toMatchObject({ isError: true, content: [{ type: "text" }] });
    expect(unconfiguredHistory.structuredContent).toBeUndefined();
    const unconfiguredText = await client.callTool({ name: "get_dataset_text", arguments: { datasetId: "d1" } });
    expect(unconfiguredText).toMatchObject({ isError: true, content: [{ type: "text" }] });
    const unconfiguredHtml = await client.callTool({ name: "get_dataset_html", arguments: { datasetId: "d1" } });
    expect(unconfiguredHtml).toMatchObject({ isError: true, content: [{ type: "text" }] });
    await client.close();
  });

  it("serves a portable history card and an honest unconfigured state", async () => {
    const client = new Client(
      { name: "integration-client", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const result = await client.callTool({ name: "get_histories", arguments: {} });
    expect(result.structuredContent).toEqual({
      status: "not_configured",
      message: "Connect a Galaxy account to show histories.",
      histories: [],
    });
    const resource = await client.readResource({ uri: HISTORY_SUMMARY_URI });
    expect(resource.contents[0]).toMatchObject({
      uri: HISTORY_SUMMARY_URI,
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: ["https://web-sandbox.oaiusercontent.com"],
          },
        },
      },
    });
    const html = "text" in resource.contents[0]! ? resource.contents[0].text : "";
    expect(html).toContain('rpc?.method === "ui/notifications/tool-result"');
    expect(html).toContain("event.source !== window.parent");
    expect(html).toContain('request("ui/initialize"');
    expect(html).toContain('method: "ui/notifications/initialized"');
    expect(html).toContain('addEventListener("openai:set_globals"');
    expect(html).toContain('Object.hasOwn(data, "success")');
    expect(html).toContain("History contents");
    expect(html).toContain('document.createElement("button")');
    expect(html).toContain('request("tools/call", {');
    expect(html).toContain('name: html ? "get_dataset_html" : "get_dataset_text"');
    expect(html).toContain("new DOMParser()");
    expect(html).toContain('setAttribute("sandbox", "")');
    expect(html).toContain('referrerPolicy = "no-referrer"');
    expect(html).toContain("result?._meta?.html");
    expect(html).toContain('setAttribute("aria-expanded"');
    expect(html).toContain("Basic Statistics");
    expect(html).toContain("Raw text");
    expect(html).toContain("white-space: pre;");
    expect(html).toContain("overflow-x: scroll;");
    expect(html).not.toContain("white-space: pre-wrap;");
    expect(html).toContain('rawText.setAttribute("aria-label", "Raw dataset text; scroll horizontally for long lines")');
    expect(html).toContain('scroller.setAttribute("aria-label", "HTML report; scroll horizontally to inspect wide content")');
    expect(html).not.toContain('identifier.textContent = string(value.id)');
    expect(html).not.toContain('" · HID "');
    expect(html).not.toContain("innerHTML");
    expect(html).not.toMatch(/https?:\/\//);
    expect(() => new Function(html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "")).not.toThrow();

    for (let version = 1; version <= 9; version += 1) {
      const legacyUri = `ui://galaxy/history-summary-v${version}.html`;
      const legacy = await client.readResource({ uri: legacyUri });
      expect(legacy.contents[0]).toMatchObject({ uri: legacyUri, mimeType: "text/html;profile=mcp-app" });
      expect("text" in legacy.contents[0]! ? legacy.contents[0].text : "").toBe(html);
    }

    const invalidUpload = await client.callTool({
      name: "upload_file_from_url",
      arguments: { url: "file:///tmp/private.fastq" },
    });
    expect(invalidUpload.isError).toBe(true);
    await client.close();
  });

  it("reads and minimizes configured Galaxy history data without logging the key", async () => {
    const apiKey = "integration-galaxy-key";
    const configured = await startTestService({
      galaxy: {
        baseUrl: "https://galaxy.example.test",
        apiKey,
        fetchImpl: async (input, init) => {
          expect(new URL(input instanceof Request ? input.url : input.toString()).pathname).toBe("/api/histories");
          expect(new Headers(input instanceof Request ? input.headers : init?.headers).get("x-api-key")).toBe(apiKey);
          return Response.json([
            { id: "h1", name: "RNA-seq", state: "ok", update_time: "2026-08-30T18:00:00Z", count: 4, ignored: "drop-me" },
            { id: "h2", name: "QC", state: "running" },
          ]);
        },
      },
    });
    const client = new Client(
      { name: "integration-client", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${configured.baseUrl}/mcp`)));

      const result = await client.callTool({ name: "get_histories", arguments: { limit: 2 } });
      expect(result.structuredContent).toEqual({
        status: "connected",
        instance: "galaxy.example.test",
        message: "2 histories found.",
        histories: [
          { id: "h1", name: "RNA-seq", state: "ok", update_time: "2026-08-30T18:00:00Z", count: 4 },
          { id: "h2", name: "QC", state: "running" },
        ],
      });
      expect(configured.logs.join("\n")).not.toContain(apiKey);
    } finally {
      await client.close();
      await configured.stop();
    }
  });

  it("supports real Galaxy inspection, search, history creation, and URL upload", async () => {
    const apiKey = "product-galaxy-key";
    const requests: Array<{ method: string; path: string; body?: string }> = [];
    const fastqcText = "##FastQC\t0.12.1\n>>Basic Statistics\tpass\n#Measure\tValue\nTotal Sequences\t5\n>>END_MODULE\n>>Per base sequence quality\tpass\n>>END_MODULE\n";
    const fastqcHtml = '<!doctype html><html><body><h1>FastQC</h1><script>alert(1)</script><a href="https://example.test">link</a><form></form></body></html>';
    const configured = await startTestService({
      galaxy: {
        baseUrl: "https://galaxy.example.test",
        apiKey,
        fetchImpl: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          requests.push({ method: request.method, path: url.pathname, ...(request.method !== "GET" && { body: await request.clone().text() }) });
          expect(request.headers.get("x-api-key")).toBe(apiKey);
          if (request.method === "GET" && url.pathname === "/api/tools") {
            return Response.json([
              { id: "toolshed.example/fastqc/0.74", name: "FastQC", description: "Read quality control" },
              { id: "toolshed.example/fastqc/0.73", name: "FastQC legacy" },
              { id: "cat1", name: "Concatenate" },
            ]);
          }
          if (request.method === "GET" && url.pathname === "/api/histories/h1/contents") {
            return Response.json([{ id: "d1", history_id: "h1", history_content_type: "dataset", name: "reads.fastq", state: "ok", extension: "fastqsanger", visible: true }]);
          }
          if (request.method === "GET" && url.pathname === "/api/histories/h1") {
            return Response.json({ id: "h1", name: "FastQC E2E", state: "ok", count: 3, user_id: "private-user", username: "private-name", state_ids: { ok: ["d1"] } });
          }
          if (request.method === "GET" && url.pathname === "/api/datasets/d1") {
            return Response.json({ id: "d1", name: "reads.fastq", state: "ok", file_ext: "fastqsanger", genome_build: "?" });
          }
          if (request.method === "GET" && url.pathname === "/api/datasets/d3") {
            return Response.json({ id: "d3", name: "FastQC RawData", state: "ok", file_ext: "txt", file_size: fastqcText.length });
          }
          if (request.method === "GET" && url.pathname === "/api/datasets/d3/get_content_as_text") {
            return Response.json({ item_data: fastqcText, truncated: false, item_url: "/ignored" });
          }
          if (request.method === "GET" && url.pathname === "/api/datasets/d4") {
            return Response.json({ id: "d4", name: "FastQC Webpage", state: "ok", file_ext: "html", file_size: fastqcHtml.length });
          }
          if (request.method === "GET" && url.pathname === "/api/datasets/d4/get_content_as_text") {
            return Response.json({ item_data: fastqcHtml, truncated: false, item_url: "/ignored" });
          }
          if (request.method === "POST" && url.pathname === "/api/histories") {
            return Response.json({ id: "h2", name: "ChatGPT FastQC", state: "new" }, { status: 201 });
          }
          if (request.method === "POST" && url.pathname === "/api/tools") {
            return Response.json({ outputs: [{ id: "d2", name: "reads.fastq" }], jobs: [{ id: "j1", state: "new" }] });
          }
          return Response.json({ err_msg: `Unexpected ${request.method} ${url.pathname}` }, { status: 404 });
        },
      },
    });
    const client = new Client(
      { name: "integration-client", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${configured.baseUrl}/mcp`)));

      const search = await client.callTool({ name: "search_tools_by_name", arguments: { query: "fastqc", limit: 1 } });
      expect(search.structuredContent).toMatchObject({
        success: true,
        data: [{ id: "toolshed.example/fastqc/0.74", name: "FastQC" }],
        pagination: { total: 2, limit: 1 },
      });
      const contents = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1", limit: 20 } });
      expect(contents.structuredContent).toMatchObject({ success: true, data: [{ id: "d1", state: "ok" }] });
      const historyDetails = await client.callTool({ name: "get_history_details", arguments: { historyId: "h1" } });
      expect(historyDetails.structuredContent).toEqual({ id: "h1", name: "FastQC E2E", state: "ok", count: 3 });
      expect(JSON.stringify(historyDetails)).not.toMatch(/private-user|private-name|state_ids/);
      const dataset = await client.callTool({ name: "get_dataset_details", arguments: { datasetId: "d1" } });
      expect(dataset.structuredContent).toMatchObject({ success: true, data: { id: "d1", file_ext: "fastqsanger" } });
      const rawInputText = await client.callTool({ name: "get_dataset_text", arguments: { datasetId: "d1" } });
      expect(rawInputText).toMatchObject({ isError: true, content: [{ type: "text" }] });
      const datasetText = await client.callTool({ name: "get_dataset_text", arguments: { datasetId: "d3", maxChars: 80 } });
      expect(datasetText.structuredContent).toEqual({
        dataset_id: "d3",
        name: "FastQC RawData",
        extension: "txt",
        text: fastqcText.slice(0, 80),
        characters_returned: 80,
        truncated: true,
      });
      const datasetHtml = await client.callTool({ name: "get_dataset_html", arguments: { datasetId: "d4" } });
      expect(datasetHtml.structuredContent).toEqual({
        dataset_id: "d4",
        name: "FastQC Webpage",
        extension: "html",
        characters_returned: fastqcHtml.length,
        truncated: false,
      });
      expect((datasetHtml as { _meta?: { html?: string } })._meta?.html).toBe(fastqcHtml);
      expect(JSON.stringify(datasetHtml.content)).not.toContain("<script>");
      expect(JSON.stringify(datasetHtml.structuredContent)).not.toContain("<script>");
      const history = await client.callTool({ name: "create_history", arguments: { historyName: "ChatGPT FastQC" } });
      expect(history.structuredContent).toMatchObject({ success: true, data: { id: "h2", name: "ChatGPT FastQC" } });
      const upload = await client.callTool({
        name: "upload_file_from_url",
        arguments: { url: "https://example.test/reads.fastq", historyId: "h2", fileType: "fastqsanger" },
      });
      expect(upload.structuredContent).toMatchObject({ success: true, data: { jobs: [{ id: "j1", state: "new" }] } });
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/tools",
        "GET /api/histories/h1/contents",
        "GET /api/histories/h1",
        "GET /api/datasets/d1",
        "GET /api/datasets/d1",
        "GET /api/datasets/d3",
        "GET /api/datasets/d3/get_content_as_text",
        "GET /api/datasets/d4",
        "GET /api/datasets/d4/get_content_as_text",
        "POST /api/histories",
        "POST /api/tools",
      ]);
      expect(configured.logs.join("\n")).not.toContain(apiKey);
    } finally {
      await client.close();
      await configured.stop();
    }
  });

  it("accepts legacy initialize", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "0.1.0" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"protocolVersion":"2025-11-25"');
  });

  it("rejects malformed JSON and missing or conflicting routing headers", async () => {
    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()) as object).toHaveProperty("error.code", -32700);

    const missingVersion = modernRequest("tools/list");
    missingVersion.headers.delete("mcp-protocol-version");
    const missingVersionResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: missingVersion.headers,
      body: JSON.stringify(missingVersion.body),
    });
    expect(missingVersionResponse.status).toBe(400);
    expect((await missingVersionResponse.json()) as object).toHaveProperty("error.code", -32020);

    const conflictingVersion = modernRequest("tools/list");
    conflictingVersion.headers.set("mcp-protocol-version", "2025-11-25");
    const conflictingVersionResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: conflictingVersion.headers,
      body: JSON.stringify(conflictingVersion.body),
    });
    expect(conflictingVersionResponse.status).toBe(400);
    expect((await conflictingVersionResponse.json()) as object).toHaveProperty("error.code", -32020);

    const missingMethod = modernRequest("tools/list");
    missingMethod.headers.delete("mcp-method");
    missingMethod.headers.set("x-request-id", "missing-method-request");
    const missingMethodResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: missingMethod.headers,
      body: JSON.stringify(missingMethod.body),
    });
    expect(missingMethodResponse.status).toBe(400);
    expect((await missingMethodResponse.json()) as object).toHaveProperty("error.code", -32020);
    expect(logs.some((line) => line.includes('"request_id":"missing-method-request"') && line.includes('"jsonrpc_error_code":-32020'))).toBe(true);
  });

});
