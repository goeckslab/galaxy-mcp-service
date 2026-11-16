import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { startTestService } from "../helpers/service.js";

it("pages histories in groups of five and creates presentation metadata only on explicit display", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, name: `History ${i}`, state: "ok" }));
  const offsets: number[] = [];
  let unbounded = false;
  const service = await startTestService({ galaxy: {
    baseUrl: "https://galaxy.example.test", apiKey: "history-pagination-test",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/api/histories");
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      expect(limit).toBe(6);
      offsets.push(offset);
      return Response.json(unbounded ? rows : rows.slice(offset, offset + limit));
    },
  } });
  const client = new Client({ name: "history-list-pagination", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.baseUrl}/mcp`)));
    for (const offset of [0, 5, 10]) {
      const result = await client.callTool({ name: "get_histories", arguments: { offset } });
      expect(result.structuredContent).toMatchObject({
        histories: rows.slice(offset, offset + 5),
        pagination: { offset, limit: 5, returned: Math.min(5, 12 - offset), has_more: offset < 10, ...(offset < 10 && { next_offset: offset + 5 }) },
      });
      expect(result.structuredContent).not.toHaveProperty("presentation");
      expect(result.structuredContent).not.toHaveProperty("pagination.total");
    }
    expect(offsets).toEqual([0, 5, 10]);
    const display = await client.callTool({ name: "show_histories", arguments: {} });
    expect(display.structuredContent).toHaveProperty("presentation.display_status", "unconfirmed");
    unbounded = true;
    const failed = await client.callTool({ name: "get_histories", arguments: {} });
    expect(failed).toMatchObject({ isError: true, structuredContent: { status: "error", histories: [] } });
  } finally {
    await client.close();
    await service.stop();
  }
});

it.each(["https://usegalaxy.org", "https://usegalaxy.eu", "https://galaxy.example.test/galaxy/"])("returns bounded history pages and instance-specific links for %s", async baseUrl => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `d${index}`, name: `Result ${index + 1}`, state: "ok", history_content_type: "dataset",
  }));
  const queries: URLSearchParams[] = [];
  const service = await startTestService({
    galaxy: {
      baseUrl, apiKey: "pagination-test-key",
      fetchImpl: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.endsWith("/contents")) queries.push(url.searchParams);
        if (url.pathname.endsWith("/api/histories") || url.pathname.includes("unavailable")) {
          return Response.json({ err_msg: "Temporarily unavailable" }, { status: 503 });
        }
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        // The real legacy endpoint ignores limit/offset unless v=dev is explicit.
        return Response.json(url.searchParams.get("v") === "dev" && !url.pathname.includes("unbounded") ? rows.slice(offset, offset + limit) : rows);
      },
    },
  });
  const client = new Client({ name: "pagination-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.baseUrl}/mcp`)));
    const first = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1" } });
    expect(first.structuredContent).toMatchObject({
      success: true, history_id: "h1", data: rows.slice(0, 5),
      history_url: `${baseUrl.replace(/\/$/, "")}/histories/view?id=h1`,
      pagination: { offset: 0, limit: 5, returned: 5, has_more: true, next_offset: 5 },
    });
    expect(first.structuredContent).not.toHaveProperty("pagination.total");
    expect(queries[0]?.get("limit")).toBe("6");
    expect(queries[0]?.get("v")).toBe("dev");
    expect(queries[0]?.get("order")).toBe("hid-asc");
    const second = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1", offset: 20, deleted: false, visible: true } });
    expect(second.structuredContent).toMatchObject({
      success: true, data: rows.slice(20),
      pagination: { offset: 20, limit: 5, returned: 5, has_more: false },
    });
    expect(second.structuredContent).not.toHaveProperty("pagination.next_offset");
    expect(queries[1]?.getAll("q")).toEqual(["deleted", "visible"]);
    expect(queries[1]?.getAll("qv")).toEqual(["false", "true"]);
    const invalid = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1", limit: 101 } });
    expect(invalid.isError).toBe(true);
    expect(queries).toHaveLength(2);
    const failed = await client.callTool({ name: "get_history_contents", arguments: { historyId: "unavailable" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { success: false } });
    const failedOverview = await client.callTool({ name: "get_histories", arguments: {} });
    expect(failedOverview).toMatchObject({ isError: true, structuredContent: { status: "error", histories: [] } });
    const unbounded = await client.callTool({ name: "get_history_contents", arguments: { historyId: "unbounded" } });
    expect(unbounded.isError).toBe(true);
    expect(unbounded.structuredContent).toBeUndefined();
    expect(JSON.stringify(unbounded.content)).toContain("Pagination cannot be verified");
    const encoded = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h /?&" } });
    expect(encoded.structuredContent).toHaveProperty("history_url", `${baseUrl.replace(/\/$/, "")}/histories/view?id=h%20%2F%3F%26`);
    expect(JSON.stringify(encoded.structuredContent)).not.toContain("pagination-test-key");
  } finally {
    await client.close();
    await service.stop();
  }
});

it("finds generic reports beyond page one with compact candidates, bounded lookup and direct presentation", async () => {
  const rows = Array.from({ length: 650 }, (_, index) => ({
    id: `d${index}`, name: [140, 170].includes(index) ? "Analysis report" : `Result ${index}`,
    state: "ok", file_ext: [140, 170].includes(index) ? "html" : "txt", history_content_type: "dataset",
    internal_path: "server-only", metadata: { redundant: "large metadata ".repeat(1000) },
  }));
  const requests: string[] = [];
  const service = await startTestService({ galaxy: {
    baseUrl: "https://galaxy.example.test", apiKey: "pagination-test-key",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      requests.push(url.pathname + url.search);
      if (url.pathname === "/api/datasets/d140") return Response.json(rows[140]);
      if (url.pathname === "/api/datasets/raw") return Response.json({ id: "raw", state: "ok", file_ext: "fastqsanger" });
      if (!url.pathname.startsWith("/api/histories/")) return Response.json({}, { status: 404 });
      const source = url.pathname.includes("/small/") ? rows.slice(0, 180) : rows;
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return Response.json(url.searchParams.get("v") === "dev" ? source.slice(offset, offset + limit) : source);
    },
  } });
  const client = new Client({ name: "report-lookup-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.baseUrl}/mcp`)));
    const lookup = await client.callTool({ name: "get_history_contents", arguments: { historyId: "small", query: "ANALYSIS", extension: "html" } });
    expect(lookup.structuredContent).toMatchObject({
      success: true, data: [{ id: "d140", name: "Analysis report", extension: "html" }, { id: "d170", name: "Analysis report", extension: "html" }],
      search: { scanned: 180, complete: true }, pagination: { has_more: false },
    });
    expect(JSON.stringify(lookup)).not.toMatch(/server-only|redundant|internal_path/);
    expect(JSON.stringify(lookup).length).toBeLessThan(4000);
    const missing = await client.callTool({ name: "get_history_contents", arguments: { historyId: "large", query: "absent" } });
    expect(missing.structuredContent).toMatchObject({ data: [], search: { scanned: 500, complete: false }, pagination: { has_more: true, next_offset: 500 } });
    const tail = await client.callTool({ name: "get_history_contents", arguments: { historyId: "large", query: "absent", offset: 500 } });
    expect(tail.structuredContent).toMatchObject({ data: [], search: { scanned: 150, complete: false }, pagination: { has_more: false } });
    const noMatches = await client.callTool({ name: "get_history_contents", arguments: { historyId: "small", query: "absent" } });
    expect(noMatches.structuredContent).toMatchObject({ data: [], search: { complete: true }, pagination: { has_more: false } });
    const first = await client.callTool({ name: "get_history_contents", arguments: { historyId: "small", query: "analysis", limit: 1 } });
    expect(first.structuredContent).toMatchObject({ data: [{ id: "d140" }], pagination: { next_offset: 141 }, search: { complete: false } });
    const next = await client.callTool({ name: "get_history_contents", arguments: { historyId: "small", query: "analysis", limit: 1, offset: 141 } });
    expect(next.structuredContent).toMatchObject({ data: [{ id: "d170" }], pagination: { next_offset: 171 } });
    const beforeDisplay = requests.length;
    const report = await client.callTool({ name: "show_dataset", arguments: { datasetId: "d140" } });
    expect(requests.slice(beforeDisplay)).toEqual(["/api/datasets/d140"]);
    expect(report.structuredContent).toMatchObject({ success: true, view: "dataset", data: [{ id: "d140", extension: "html" }], url: "https://galaxy.example.test/datasets/d140/display" });
    expect(JSON.stringify(report.content)).toContain("visibility unconfirmed");
    expect(report.structuredContent).toHaveProperty("presentation.display_status", "unconfirmed");
    const reopened = await client.callTool({ name: "show_dataset", arguments: { datasetId: "d140" } });
    const viewId = (value: typeof report) => (value.structuredContent as { presentation: { view_id: string } }).presentation.view_id;
    expect(viewId(report)).toMatch(/^[0-9a-f-]{36}$/);
    expect(viewId(reopened)).not.toBe(viewId(report));
    expect(lookup.structuredContent).not.toHaveProperty("presentation");
    const displayedHistory = await client.callTool({ name: "show_history", arguments: { historyId: "small" } });
    expect(displayedHistory.structuredContent).toHaveProperty("presentation.display_status", "unconfirmed");
    expect(JSON.stringify(report)).not.toContain("server-only");
    const rawPreview = await client.callTool({ name: "show_dataset", arguments: { datasetId: "raw" } });
    expect(rawPreview.structuredContent).toMatchObject({ success: true, view: "dataset", data: [{ extension: "fastqsanger" }] });
    expect(requests.at(-1)).toBe("/api/datasets/raw");
  } finally {
    await client.close();
    await service.stop();
  }
});
