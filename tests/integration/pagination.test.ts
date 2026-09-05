import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { startTestService } from "../helpers/service.js";

it("returns bounded, resumable history pages and marks failed operations as MCP errors", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `d${index}`, name: `Result ${index + 1}`, state: "ok", history_content_type: "dataset",
  }));
  const queries: URLSearchParams[] = [];
  const service = await startTestService({
    galaxy: {
      baseUrl: "https://galaxy.example.test", apiKey: "pagination-test-key",
      fetchImpl: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        queries.push(url.searchParams);
        if (url.pathname === "/api/histories" || url.pathname.includes("unavailable")) {
          return Response.json({ err_msg: "Temporarily unavailable" }, { status: 503 });
        }
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        return Response.json(rows.slice(offset, offset + limit));
      },
    },
  });
  const client = new Client({ name: "pagination-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.baseUrl}/mcp`)));
    const first = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1" } });
    expect(first.structuredContent).toMatchObject({
      success: true, history_id: "h1", data: rows.slice(0, 20),
      pagination: { offset: 0, limit: 20, returned: 20, has_more: true, next_offset: 20 },
    });
    expect(first.structuredContent).not.toHaveProperty("pagination.total");
    expect(queries[0]?.get("limit")).toBe("21");
    const second = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1", offset: 20 } });
    expect(second.structuredContent).toMatchObject({
      success: true, data: rows.slice(20),
      pagination: { offset: 20, limit: 20, returned: 5, has_more: false },
    });
    expect(second.structuredContent).not.toHaveProperty("pagination.next_offset");
    const invalid = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1", limit: 101 } });
    expect(invalid.isError).toBe(true);
    expect(queries).toHaveLength(2);
    const failed = await client.callTool({ name: "get_history_contents", arguments: { historyId: "unavailable" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { success: false } });
    const failedOverview = await client.callTool({ name: "get_histories", arguments: {} });
    expect(failedOverview).toMatchObject({ isError: true, structuredContent: { status: "error", histories: [] } });
  } finally {
    await client.close();
    await service.stop();
  }
});
