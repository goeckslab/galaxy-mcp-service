import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { startTestService } from "../helpers/service.js";

it("submits once and resumes status checks after a temporary failure", async () => {
  let submissions = 0;
  let statusReads = 0;
  const service = await startTestService({
    galaxy: {
      baseUrl: "https://galaxy.example.test", apiKey: "submission-test-key",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/api/jobs") {
          submissions += 1;
          const body = await request.json() as { tool_id: string };
          if (body.tool_id === "missing-handle") return Response.json({});
          expect(body).toMatchObject({
            history_id: "h1", tool_id: "example-tool", strict: true,
            inputs: { settings: { threshold: 12 }, reads: { src: "hda", id: "d1" } },
          });
          return Response.json({ tool_request_id: "r1" });
        }
        if (path === "/api/tool_requests/r1") {
          statusReads += 1;
          if (statusReads === 1) return Response.json({ err_msg: "Try again" }, { status: 503 });
          return Response.json({ state: "submitted", jobs: [{ id: "j1" }], implicit_collections: [] });
        }
        if (path === "/api/jobs/j1") return Response.json({
          id: "j1", state: statusReads === 2 ? "running" : "ok", outputs: { result: { id: "d2" } },
        });
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
    },
  });
  const client = new Client({ name: "submission-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.baseUrl}/mcp`)));
    const accepted = await client.callTool({ name: "run_tool", arguments: {
      toolId: "example-tool", historyId: "h1",
      inputs: { settings: { threshold: 12 }, reads: { src: "hda", id: "d1" } },
    } });
    expect(accepted.structuredContent).toMatchObject({
      success: true, data: { state: "accepted", toolRequestId: "r1", historyId: "h1", toolId: "example-tool" },
    });
    expect(statusReads).toBe(0);
    const failed = await client.callTool({ name: "get_tool_request_status", arguments: { toolRequestId: "r1" } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { success: false, recovery: { toolRequestId: "r1" } } });
    const pending = await client.callTool({ name: "get_tool_request_status", arguments: { toolRequestId: "r1" } });
    expect(pending.structuredContent).toMatchObject({ success: true, data: { state: "pending", jobs: [{ id: "j1", state: "running" }] } });
    const complete = await client.callTool({ name: "get_tool_request_status", arguments: { toolRequestId: "r1" } });
    expect(complete.structuredContent).toMatchObject({ success: true, data: { state: "ok", jobs: [{ id: "j1", state: "ok" }] } });
    expect(submissions).toBe(1);
    expect(statusReads).toBe(3);
    const unknown = await client.callTool({ name: "run_tool", arguments: {
      toolId: "missing-handle", historyId: "h1", inputs: {},
    } });
    expect(unknown).toMatchObject({ isError: true, structuredContent: { success: false } });
    expect(JSON.stringify(unknown.content)).toMatch(/outcome.*unknown/i);
    expect(submissions).toBe(2);
    expect(statusReads).toBe(3);
  } finally {
    await client.close();
    await service.stop();
  }
});
