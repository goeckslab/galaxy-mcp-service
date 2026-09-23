import { describe, expect, it } from "vitest";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  extractRequestMetadata,
  redactSecrets,
  requireModernProtocolHeader,
} from "../../packages/protocol/src/index.js";

const body = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: { _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" } },
};

describe("protocol boundary", () => {
  it("accepts a matching modern version header and rejects missing or conflicting values", () => {
    expect(requireModernProtocolHeader(body, "2026-07-28")).toBeUndefined();
    expect(requireModernProtocolHeader(body)).toMatchObject({ code: -32020 });
    expect(requireModernProtocolHeader(body, "2025-11-25")).toMatchObject({ code: -32020 });
    expect(requireModernProtocolHeader({ method: "initialize" })).toBeUndefined();
  });

  it("redacts credentials and credential-bearing URLs", () => {
    const redacted = JSON.stringify(
      redactSecrets({
        authorization: "Bearer visible-no-more",
        nested: { apiKey: "key-visible-no-more", refreshToken: "token-visible-no-more", note: "safe" },
        url: "https://user:password@example.test/file?token=visible-no-more",
      }),
    );
    expect(redacted).not.toContain("visible-no-more");
    expect(redacted).not.toContain("key-visible-no-more");
    expect(redacted).not.toContain("token-visible-no-more");
    expect(redacted).toContain("[redacted-url]");
    expect(redacted).toContain("safe");
  });

  it("does not log client-controlled capability names as content", () => {
    const metadata = extractRequestMetadata(
      {
        method: "tools/list",
        params: {
          _meta: {
            [CLIENT_INFO_META_KEY]: { name: "safe-client", version: "1" },
            [CLIENT_CAPABILITIES_META_KEY]: { "Bearer TOP_SECRET": {}, sampling: {} },
          },
        },
      },
      new Headers(),
      "POST",
      "request-1",
    );
    expect(JSON.stringify(metadata)).not.toContain("TOP_SECRET");
    expect(metadata.client_capabilities).toEqual(["[redacted]", "sampling"]);
  });

  it("records slash-delimited MCP methods without relaxing other metadata filters", () => {
    for (const method of ["initialize", "server/discover", "tools/list", "tools/call", "resources/read", "notifications/initialized"]) {
      const metadata = extractRequestMetadata(
        { method, params: { name: "unsafe/name", arguments: { note: "PRIVATE_CONTENT" } } },
        new Headers({ "mcp-method": method, "mcp-name": "unsafe/name" }),
        "POST",
        "request-1",
      );
      expect(metadata).toMatchObject({
        body_method: method,
        mcp_method: method,
        server_discover_seen: method === "server/discover",
        initialize_seen: method === "initialize",
      });
      expect(metadata.body_name_or_task_id).toBeUndefined();
      expect(metadata.mcp_name).toBeUndefined();
      expect(JSON.stringify(metadata)).not.toContain("PRIVATE_CONTENT");
    }
    for (const method of ["", "Bearer SECRET", "https://example.test/?token=SECRET", "tools/call\nSECRET", "tools//call", "/tools/call", "x".repeat(129)]) {
      const metadata = extractRequestMetadata({ method }, { get: () => method }, "POST", "request-1");
      expect(metadata.body_method).toBeUndefined();
      expect(metadata.mcp_method).toBeUndefined();
      expect(metadata.server_discover_seen).toBe(false);
    }
  });
});
