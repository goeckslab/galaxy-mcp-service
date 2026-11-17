import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { get } from "node:http";
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

  it("serves only fixed public information pages without scripts, forms or user data", async () => {
    for (const path of ["/", "/support", "/privacy", "/terms"]) {
      const response = await fetch(`${baseUrl}${path}?secret=not-for-the-page`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toMatch(/default-src 'none'; img-src 'self'; style-src 'sha256-/);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(html).toContain('<a href="/support">Support and contact</a>');
      expect(html).toContain('<link rel="icon" type="image/png" href="/favicon.png">');
      expect(html).not.toMatch(/mailto:|[\w.+-]+@gmail\.com/i);
      expect(html).not.toMatch(/<script|<form|<iframe|not-for-the-page|\/Users\//i);
    }
    expect((await fetch(`${baseUrl}/constructor`)).status).toBe(404);
    const icons = await Promise.all(["/favicon.ico", "/favicon.png"].map(path => fetch(`${baseUrl}${path}`)));
    for (const icon of icons) {
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/png");
    }
    const [ico, png] = await Promise.all(icons.map(async icon => Buffer.from(await icon.arrayBuffer())));
    expect(ico!.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(ico).toEqual(png);
    const home = await (await fetch(`${baseUrl}/`)).text();
    expect(home).toContain('href="https://usegalaxy.org.au"');
    expect(home).toContain('href="https://usegalaxy.fr"');
    expect(home).toContain('href="https://usegalaxy.ca"');
    expect(home).toContain('href="https://test.galaxyproject.org"');
    expect(home).toContain('href="https://mcp.galaxyproject.org/connections"');
    expect(home).toContain("<code>https://mcp.galaxyproject.org/mcp</code>");
    expect(home).toContain("ask naturally to remove a site, rotate a key or disconnect Galaxy");
    expect(home).not.toContain("one selected instance per authorization");
    const support = await (await fetch(`${baseUrl}/support`)).text();
    expect(support).toContain('id="request-site"');
    expect(support).toContain('href="https://github.com/goeckslab/galaxy-plugin/issues"');
    const privateContact = 'href="https://docs.google.com/forms/d/e/1FAIpQLScT1Wdt9Zc4Jp1uXTj4gEHyKL7jF7gTCBApI16ojtzljYZlGA/viewform"';
    expect(support).toContain(privateContact);
    expect(support).toContain('id="private-contact"');
    const privacy = await (await fetch(`${baseUrl}/privacy`)).text();
    expect(privacy).toContain(privateContact);
    expect(privacy).toContain("Google Forms");
    expect(privacy).toContain("not shown to other respondents");
    expect(support).toContain("Sending a request does not automatically add the site or authorize an account");
    expect(support).toContain("Do not send API keys");
    expect(support).toContain("manage my Galaxy connections");
    expect(privacy).toContain("private five-minute link");
    expect(privacy).toContain("does not use a browser login cookie");
    expect(privacy).toContain("Optional analysis notifications");
    expect(privacy).toContain("Each subscription lasts at most 24 hours");
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${baseUrl}/privacy`, { headers: { host: "attacker.example" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });
    expect(foreignHostStatus).toBe(403);
  });

  it("routes Universal OAuth users to their allowlisted Galaxy instance", async () => {
    const resource = "http://127.0.0.1/mcp";
    const issuer = "https://auth.example.test";
    const managementTicket = "t".repeat(43);
    const introspectionUrl = `${issuer}/oauth/introspect`;
    const brokerSecret = "integration-broker-secret";
    const calls: string[] = [];
    let expired = false;
    let revoked = false;
    let brokerUnavailable = false;
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
        if (brokerUnavailable) return Response.json({}, { status: 503 });
        if (token === "inactive" || (revoked && token === "token-eu")) return Response.json({ active: false });
        const instance = token === "token-eu" ? "eu" : token === "token-unknown" ? "unknown" : "us";
        return Response.json({
          active: true,
          aud: token === "wrong-audience" ? "https://other.example.test/mcp" : resource,
          client_id: "chatgpt",
          exp: Math.floor(Date.now() / 1000) + (token === "expired" || (expired && token === "token-us") ? -60 : 60),
          galaxy_connections: [{ instance, api_key: `key-${instance}`, url: `https://${instance}.example.test` }],
          iss: issuer,
          scope: token === "missing-scope" ? "profile" : "galaxy:full",
          sub: `user-${instance}`,
        });
      }
      if (request.method === "POST" && url.href === `${issuer}/management/ticket`) {
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from(`broker-client:${brokerSecret}`).toString("base64")}`,
        );
        expect(new URLSearchParams(await request.text()).get("token")).toBe("token-us");
        return Response.json({ url: `${issuer}/connections/${managementTicket}`, expires_in: 300 });
      }
      if (request.method === "GET" && url.pathname === "/api/histories" && ["us.example.test", "eu.example.test"].includes(url.host)) {
        const instance = url.host.startsWith("us") ? "us" : "eu";
        expect(request.headers.get("x-api-key")).toBe(`key-${instance}`);
        return Response.json([{ id: `h-${instance}`, name: `${instance.toUpperCase()} history`, state: "ok" }]);
      }
      if (request.method === "GET" && url.host === "us.example.test") {
        expect(request.headers.get("x-api-key")).toBe("key-us");
        if (url.pathname === "/api/tool_requests/r1") return Response.json({
          state: "submitted", jobs: [{ id: "j1" }], implicit_collections: [],
        });
        if (url.pathname === "/api/jobs/j1") return Response.json({ id: "j1", state: "ok" });
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
    let configured = await startTestService({ auth, publicBaseUrl: "http://127.0.0.1" });
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

      await Promise.all(["us", "eu"].map(async instance => {
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
      }));

      const management = modernRequest("tools/call", { name: "get_connection_management_link", arguments: {} });
      management.headers.set("authorization", "Bearer token-us");
      const managementResponse = await fetch(`${configured.baseUrl}/mcp`, {
        method: "POST", headers: management.headers, body: JSON.stringify(management.body),
      });
      expect(await managementResponse.json()).toMatchObject({ result: { structuredContent: {
        url: `${issuer}/connections/${managementTicket}`, expires_in: 300,
      } } });

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
      expect(calls.filter((call) => call.includes("/api/histories")).sort()).toEqual([
        "GET eu.example.test/api/histories",
        "GET us.example.test/api/histories",
      ]);
      expect(calls.filter((call) => call.endsWith("/oauth/introspect"))).toHaveLength(8);
      expect(calls.filter((call) => call.endsWith("/management/ticket"))).toHaveLength(1);
      expect(calls[0]).toBe(
        "GET auth.example.test/.well-known/oauth-authorization-server",
      );

      // Expiry/revocation are checked on every request, not cached per MCP connection.
      const readExistingRun = async (token: string) => {
        const request = modernRequest("tools/call", {
          name: "get_tool_request_status", arguments: { toolRequestId: "r1" },
        });
        request.headers.set("authorization", `Bearer ${token}`);
        return fetch(`${configured.baseUrl}/mcp`, {
          method: "POST", headers: request.headers, body: JSON.stringify(request.body),
        });
      };
      expired = true;
      revoked = true;
      const beforeRejected = calls.filter(call => !call.includes("auth.example.test")).length;
      for (const token of ["token-us", "token-eu"]) {
        const response = await readExistingRun(token);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("invalid_token");
      }
      expect(calls.filter(call => !call.includes("auth.example.test"))).toHaveLength(beforeRejected);
      const resumed = await readExistingRun("renewed-us");
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ result: { structuredContent: {
        success: true, data: { state: "ok", jobs: [{ id: "j1", state: "ok" }] },
      } } });

      brokerUnavailable = true;
      const beforeOutage = calls.filter(call => !call.includes("auth.example.test")).length;
      expect((await readExistingRun("renewed-us")).status).toBe(500);
      expect(calls.filter(call => !call.includes("auth.example.test"))).toHaveLength(beforeOutage);
      brokerUnavailable = false;
      const previousLogs = configured.logs.slice();
      await configured.stop();
      configured = await startTestService({ auth, publicBaseUrl: "http://127.0.0.1" });
      expect((await readExistingRun("renewed-us")).status).toBe(200);
      expect((await readExistingRun("token-eu")).status).toBe(401);
      expect(calls.filter(call => !call.includes("auth.example.test")).every(call => call.startsWith("GET "))).toBe(true);
      // Connection-management links open on the broker's origin, wherever it is hosted.
      const card = modernRequest("resources/read", { uri: HISTORY_SUMMARY_URI });
      card.headers.set("authorization", "Bearer renewed-us");
      card.headers.set("mcp-name", HISTORY_SUMMARY_URI);
      const read = await (await fetch(`${configured.baseUrl}/mcp`, {
        method: "POST", headers: card.headers, body: JSON.stringify(card.body),
      })).json() as { result: { contents: Array<{ text: string; _meta: Record<string, { redirect_domains?: string[]; connect_domains?: string[]; csp?: { connectDomains: string[] } }> }> } };
      expect(read.result.contents[0]!._meta["openai/widgetCSP"]!.redirect_domains).toEqual([issuer]);
      // The card may contact only this user's Galaxy sites, for its direct file upload.
      expect(read.result.contents[0]!._meta["openai/widgetCSP"]!.connect_domains).toEqual(["https://us.example.test"]);
      expect(read.result.contents[0]!._meta.ui!.csp!.connectDomains).toEqual(["https://us.example.test"]);
      expect(read.result.contents[0]!.text).toContain(`const managementOrigin = "${issuer}";`);
      expect([...previousLogs, ...configured.logs].join("\n")).not.toMatch(
        /key-us|key-eu|integration-broker-secret|token-us|token-eu|renewed-us/,
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
      "get_galaxy_connections",
      "show_galaxy",
      "get_histories",
      "show_histories",
      ...productOperations.flatMap(({ name }) => name === "get_history_contents" ? [name, "show_history"] : [name]),
      "show_dataset",
      "get_run_status",
      "show_run_status",
      "get_dataset_text",
      "get_dataset_html",
      "read_dataset_report",
      "create_collection",
      "start_file_upload",
      "finish_file_upload",
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

  it.each(["auto", "legacy"] as const)("delivers shared guidance and text fallback to a tools-only %s client", async mode => {
    const client = new Client(
      { name: "tools-only-client", version: "1" },
      { capabilities: {}, versionNegotiation: { mode } },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      const instructions = client.getInstructions();
      expect(instructions).toContain("Galaxy tools work without UI.");
      expect(instructions).toContain("submit once");
      expect(instructions).toContain("get_dataset_text");
      expect(instructions).toContain("read_dataset_report");
      expect(instructions!.length).toBeLessThanOrEqual(512);
      const result = await client.callTool({ name: "get_histories", arguments: {} });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      expect(JSON.parse(content[0]!.text!)).toEqual(result.structuredContent);
      expect(result.structuredContent).toMatchObject({ status: "not_configured" });
    } finally {
      await client.close();
    }
  });

  it("keeps the ChatGPT origin host-specific for the current UI resource without widening network access", async () => {
    for (const publicBaseUrl of ["https://MCP.example.test/", "http://localhost", "", "  ", undefined]) {
      const configured = await startTestService(publicBaseUrl === undefined ? {} : { publicBaseUrl });
      const client = new Client({ name: "widget-domain-check", version: "0.1.0" }, { capabilities: {} });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${configured.baseUrl}/mcp`)));
        const domain = publicBaseUrl?.startsWith("https:") ? "https://mcp.example.test" : undefined;
        expect(client.getServerVersion()?.icons).toEqual(domain ? [{ src: `${domain}/favicon.png`, mimeType: "image/png", sizes: ["256x256"] }] : undefined);
        const listed = await client.listResources();
        expect(listed.resources.map(resource => resource.uri)).toEqual([HISTORY_SUMMARY_URI]);
        for (const { uri, _meta } of listed.resources) {
          const result = await client.readResource({ uri });
          const domain = publicBaseUrl?.startsWith("https:") ? "https://mcp.example.test" : undefined;
          const expected = {
            ...(domain && { "openai/widgetDomain": domain }),
            "openai/widgetCSP": {
              connect_domains: [], resource_domains: [], redirect_domains: [],
            },
            ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
          };
          expect(result.contents[0]?._meta).toEqual(expected);
          expect(_meta).toEqual(expected);
        }
      } finally { await client.close(); await configured.stop(); }
    }
  });

  it("serves a portable history card and an honest unconfigured state", async () => {
    const client = new Client(
      { name: "integration-client", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const result = await client.callTool({ name: "show_histories", arguments: {} });
    expect(result.structuredContent).toEqual({
      status: "not_configured",
      message: "Connect a Galaxy account to show histories.",
      histories: [],
      presentation: { view_id: expect.any(String), display_status: "unconfirmed", message: expect.stringContaining("visibility unconfirmed") },
    });
    const resource = await client.readResource({ uri: HISTORY_SUMMARY_URI });
    expect(resource.contents[0]).toMatchObject({
      uri: HISTORY_SUMMARY_URI,
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: [],
          redirect_domains: [],
        },
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
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
    expect(html).toContain('name: html ? "get_dataset_html" : "read_dataset_report"');
    expect(html).toContain("new DOMParser()");
    expect(html).not.toMatch(/createElement\("iframe"\)|\.srcdoc/);
    expect(html).toContain("Static report preview");
    expect(html).toContain("result?._meta?.html");
    expect(html).toContain('setAttribute("aria-expanded"');
    expect(html).toContain("Basic Statistics");
    expect(html).toContain("Raw text");
    expect(html).toContain("white-space: pre;");
    expect(html).toContain("overflow-x: scroll;");
    expect(html).not.toContain("white-space: pre-wrap;");
    expect(html).toContain('rawText.setAttribute("aria-label", "Raw dataset text; scroll horizontally for long lines")');
    expect(html).toContain('scroller.setAttribute("aria-label", "Static report preview; scroll horizontally for wide tables and images")');
    expect(html).not.toContain('identifier.textContent = string(value.id)');
    expect(html).not.toContain('" · HID "');
    expect(html).not.toContain("innerHTML");
    expect(html.replaceAll("http://www.w3.org/1999/xhtml", "")).not.toMatch(/https?:\/\//);
    expect(() => new Function(html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "")).not.toThrow();

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
        galaxy: { instance: "galaxy.example.test", url: "https://galaxy.example.test" },
        instance: "galaxy.example.test",
        message: "2 histories returned.",
        pagination: { offset: 0, limit: 2, returned: 2, has_more: false },
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
          if (request.method === "POST" && url.pathname === "/api/dataset_collections") {
            const body = await request.clone().json() as { name: string; collection_type: string; history_id: string; element_identifiers: unknown[] };
            if (body.name === "Rejected") return Response.json({ err_msg: "Dataset d9 is not in this history.", err_code: 400008 }, { status: 400 });
            return Response.json({ id: "c1", name: body.name, collection_type: body.collection_type, history_id: body.history_id,
              element_count: body.element_identifiers.length, hid: 3, populated_state: "ok" });
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
      expect(contents.structuredContent).toMatchObject({ success: true, data: [{ id: "d1", state: "ok" }], history_name: "FastQC E2E" });
      // Galaxy's own snake_case names work too, and a missing id is named both ways.
      const snakeCased = await client.callTool({ name: "get_history_contents", arguments: { history_id: "h1", limit: 20 } });
      expect(snakeCased.structuredContent).toEqual(contents.structuredContent);
      const missing = await client.callTool({ name: "get_history_contents", arguments: { limit: 20 } });
      expect(missing).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("historyId (or history_id)") }] });
      const historyDetails = await client.callTool({ name: "get_history_details", arguments: { historyId: "h1" } });
      expect(historyDetails.structuredContent).toEqual({ id: "h1", name: "FastQC E2E", state: "ok", count: 3,
        galaxy: { instance: "galaxy.example.test", url: "https://galaxy.example.test" },
      });
      expect(JSON.stringify(historyDetails)).not.toMatch(/private-user|private-name|state_ids/);
      const dataset = await client.callTool({ name: "get_dataset_details", arguments: { datasetId: "d1" } });
      expect(dataset.structuredContent).toMatchObject({ success: true, data: { id: "d1", file_ext: "fastqsanger" } });
      const rawInputText = await client.callTool({ name: "get_dataset_text", arguments: { datasetId: "d1" } });
      expect(rawInputText).toMatchObject({ isError: true, content: expect.arrayContaining([{ type: "text", text: expect.stringContaining("reads only") }]) });
      const datasetText = await client.callTool({ name: "get_dataset_text", arguments: { dataset_id: "d3", max_chars: 80 } });
      expect(datasetText.structuredContent).toEqual({
        galaxy: { instance: "galaxy.example.test", url: "https://galaxy.example.test" },
        dataset_id: "d3",
        name: "FastQC RawData",
        extension: "txt",
        text: fastqcText.slice(0, 80),
        characters_returned: 80,
        truncated: true,
      });
      const datasetHtml = await client.callTool({ name: "get_dataset_html", arguments: { datasetId: "d4" } });
      expect(datasetHtml.structuredContent).toEqual({
        galaxy: { instance: "galaxy.example.test", url: "https://galaxy.example.test" },
        dataset_id: "d4",
        url: "https://galaxy.example.test/datasets/d4/display",
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
      const samples = await client.callTool({ name: "create_collection", arguments: {
        history_id: "h2", name: "Samples", collection_type: "list:paired",
        elements: [{ name: "s1", forward: "d1", reverse: "d2" }, { name: "s2", forward: "d5", reverse: "d6" }],
      } });
      expect(samples.structuredContent).toEqual({
        success: true, galaxy: { instance: "galaxy.example.test", url: "https://galaxy.example.test" },
        data: { id: "c1", name: "Samples", collection_type: "list:paired", history_id: "h2", element_count: 2, hid: 3 },
        message: "Created list:paired collection Samples. Pass it to tools and workflows as {src:'hdca',id}.",
      });
      expect(JSON.parse(requests.at(-1)!.body!)).toEqual({
        history_id: "h2", name: "Samples", collection_type: "list:paired", instance_type: "history", copy_elements: true, hide_source_items: false, fields: [],
        element_identifiers: [
          { name: "s1", src: "new_collection", collection_type: "paired", element_identifiers: [{ name: "forward", src: "hda", id: "d1" }, { name: "reverse", src: "hda", id: "d2" }] },
          { name: "s2", src: "new_collection", collection_type: "paired", element_identifiers: [{ name: "forward", src: "hda", id: "d5" }, { name: "reverse", src: "hda", id: "d6" }] },
        ],
      });
      const rejected = await client.callTool({ name: "create_collection", arguments: {
        historyId: "h2", name: "Rejected", collectionType: "list", elements: [{ name: "a", dataset: "d9" }],
      } });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toMatchObject({ success: false, message: "Galaxy did not create the collection: Dataset d9 is not in this history." });
      // A request that cannot describe its collection type never reaches Galaxy.
      const sent = requests.length;
      for (const [collectionType, elements] of [
        ["list", [{ name: "a", dataset: "d1" }, { name: "a", dataset: "d2" }]],
        ["list", [{ name: "a", forward: "d1", reverse: "d2" }]],
        ["paired", [{ forward: "d1", reverse: "d2" }, { forward: "d5", reverse: "d6" }]],
        ["list:paired", [{ name: "s1", forward: "d1" }]],
      ] as const) {
        const invalid = await client.callTool({ name: "create_collection", arguments: { historyId: "h2", name: "Invalid", collectionType, elements } });
        expect(invalid.isError).toBe(true);
        expect((invalid.structuredContent as { message: string }).message).toMatch(/No Galaxy request was sent\.$/);
      }
      expect(requests).toHaveLength(sent);
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/tools",
        "GET /api/histories/h1",
        "GET /api/histories/h1/contents",
        "GET /api/histories/h1",
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
        "POST /api/dataset_collections",
        "POST /api/dataset_collections",
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
