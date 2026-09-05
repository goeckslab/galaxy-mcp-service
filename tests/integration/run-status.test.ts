import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { startTestService } from "../helpers/service.js";

it("reads tool and workflow cards, refreshes and opens history without submitting any analysis", async () => {
  const requests: string[] = [];
  let jobState = "running";
  let unavailable = false;
  const service = await startTestService({ galaxy: {
    baseUrl: "https://galaxy.example.test", apiKey: "status-integration-secret",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("error");
      requests.push(url.pathname);
      if (unavailable) return Response.json({ err_msg: "temporary outage" }, { status: 503 });
      if (url.pathname === "/api/tool_requests/r1") return Response.json({
        id: "r1", state: "submitted", jobs: [{ id: "j1" }], request: { history_id: "h1", tool_id: "example" },
      });
      if (url.pathname === "/api/jobs/j1") return Response.json({ id: "j1", state: jobState, history_id: "h1", tool_id: "example" });
      if (url.pathname === "/api/tools/example") return Response.json({ id: "example", name: "Example analysis" });
      if (url.pathname === "/api/invocations/i1") return Response.json({ id: "i1", state: "scheduled", history_id: "h1", workflow_id: "w1" });
      if (url.pathname === "/api/workflows/w1") {
        expect(url.searchParams.get("instance")).toBe("true");
        return Response.json({ id: "w1", name: "Example workflow" });
      }
      if (url.pathname === "/api/invocations/i1/jobs_summary") return Response.json({ populated_state: "ok", states: { [jobState]: 1 } });
      if (url.pathname === "/api/histories/h1/contents") return Response.json([{ id: "d1", name: "Result report", state: "ok", extension: "txt" }]);
      throw new Error(`Unexpected read: ${url.pathname}`);
    },
  } });
  const client = new Client({ name: "run-status-integration", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${service.baseUrl}/mcp`)));
    const read = (kind: string, runId: string) => client.callTool({ name: "get_run_status", arguments: { kind, runId } });
    expect((await read("tool", "r1")).structuredContent).toMatchObject({
      success: true, run: { name: "Example analysis", state: "running", history_id: "h1", jobs: { running: 1, total: 1 } },
    });
    expect((await read("workflow", "i1")).structuredContent).toMatchObject({
      success: true, run: { name: "Example workflow", state: "running", history_id: "h1" },
    });
    jobState = "ok";
    expect((await read("tool", "r1")).structuredContent).toMatchObject({ success: true, run: { state: "completed", jobs: { completed: 1 } } });
    const results = await client.callTool({ name: "get_history_contents", arguments: { historyId: "h1" } });
    expect(results.structuredContent).toMatchObject({ success: true, data: [{ name: "Result report" }] });
    unavailable = true;
    expect(await read("tool", "r1")).toMatchObject({ isError: true, structuredContent: { success: false, run: { id: "r1", state: "unknown" } } });
    const count = requests.length;
    expect((await read("job", "j1")).isError).toBe(true);
    expect((await read("tool", " ")).isError).toBe(true);
    expect(requests).toHaveLength(count);
    expect(service.logs.join("\n")).not.toContain("status-integration-secret");
  } finally {
    await client.close();
    await service.stop();
  }
});
