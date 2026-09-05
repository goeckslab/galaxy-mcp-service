import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { productOperations } from "../../apps/service/src/mcp.js";
import { HISTORY_SUMMARY_URI } from "../../apps/service/src/history-summary-ui.js";
import { postModern, startTestService } from "../helpers/service.js";

let baseUrl: string;
let stop: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const service = await startTestService();
  baseUrl = service.baseUrl;
  stop = service.stop;
});

afterAll(async () => stop());

describe("Galaxy tool contract", () => {
  it("exposes the real Galaxy product surface with accurate annotations", async () => {
    const response = await postModern(baseUrl, "tools/list");
    const payload = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: Record<string, unknown>;
          outputSchema?: Record<string, unknown>;
          annotations: Record<string, boolean>;
          _meta?: Record<string, unknown>;
        }>;
      };
    };
    const tools = payload.result.tools;

    expect(response.status).toBe(200);
    expect(tools.map(({ name }) => name)).toEqual([
      "get_histories",
      ...productOperations.map(({ name }) => name),
      "get_run_status",
      "get_dataset_text",
      "get_dataset_html",
    ]);
    expect(tools.map(({ name }) => name)).not.toContain("read_probe");
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: true,
      });
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/api[_-]?key|password|secret|token/i);
    }
    expect(tools[0]).toMatchObject({
      name: "get_histories",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI } },
    });
    expect(tools.find(({ name }) => name === "get_history_contents")).toMatchObject({
      name: "get_history_contents",
      _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI } },
    });
    expect(tools.find(({ name }) => name === "get_history_contents")?.inputSchema).toMatchObject({
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
    });
    expect(tools.find(({ name }) => name === "get_run_status")).toMatchObject({
      inputSchema: { type: "object", required: ["kind", "runId"], additionalProperties: false },
      outputSchema: { type: "object", required: ["success", "run"] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI } },
    });
    for (const name of ["run_tool", "invoke_workflow", "get_tool_request_status", "get_invocations"]) {
      expect(tools.find((tool) => tool.name === name)?._meta ?? {}).not.toHaveProperty("ui.resourceUri");
    }
    expect(tools.find(({ name }) => name === "get_history_details")?.outputSchema).toMatchObject({
      type: "object",
      required: ["id", "name", "state", "count"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        state: { type: "string" },
        count: { type: "integer", minimum: 0 },
      },
    });
    expect(tools.find(({ name }) => name === "get_dataset_text")).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["datasetId"],
        properties: {
          datasetId: { type: "string", minLength: 1 },
          maxChars: { type: "integer", minimum: 1, maximum: 50_000, default: 20_000 },
        },
      },
      outputSchema: {
        type: "object",
        required: ["dataset_id", "name", "extension", "text", "characters_returned", "truncated"],
      },
    });
    expect(tools.find(({ name }) => name === "get_dataset_html")).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { visibility: ["app"] } },
      inputSchema: {
        type: "object",
        required: ["datasetId"],
        properties: { datasetId: { type: "string", minLength: 1 } },
      },
      outputSchema: {
        type: "object",
        required: ["dataset_id", "name", "extension", "characters_returned", "truncated"],
      },
    });
    expect(tools.find(({ name }) => name === "run_tool")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(tools.find(({ name }) => name === "cancel_workflow_invocation")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("does not expose server-filesystem or unrestricted account-management operations", async () => {
    const response = await postModern(baseUrl, "tools/list");
    const payload = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    const names = payload.result.tools.map(({ name }) => name);
    for (const forbidden of ["upload_file", "download_dataset", "update_history", "create_user_tool", "delete_user_tool"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
