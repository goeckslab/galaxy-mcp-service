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
    ]);
    expect(tools.map(({ name }) => name)).not.toContain("read_probe");
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/api[_-]?key|password|secret|token/i);
      if (!["get_galaxy_connections", "show_galaxy"].includes(tool.name)) {
        expect(tool.inputSchema).toHaveProperty("properties.instance.type", "string");
        expect(tool.outputSchema).toHaveProperty("properties.galaxy.properties.instance.type", "string");
      }
    }
    expect(tools.filter(({ annotations }) => annotations.openWorldHint).map(({ name }) => name).sort()).toEqual([
      "get_server_info", "search_tools_by_name", "get_tool_details", "get_tool_citations",
      "get_tool_run_examples", "get_tool_input_template", "upload_file_from_url", "run_tool",
      "invoke_workflow", "search_iwc_workflows", "recommend_iwc_workflows",
      "get_iwc_workflow_details", "import_workflow_from_iwc",
    ].sort());
    for (const name of ["get_user", "get_histories", "get_history_contents", "show_dataset", "get_dataset_text", "get_dataset_html", "read_dataset_report", "get_run_status", "create_history", "cancel_workflow_invocation"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations.openWorldHint).toBe(false);
    }
    expect(tools.find(({ name }) => name === "show_histories")).toMatchObject({
      name: "show_histories",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI } },
    });
    expect(tools.find(({ name }) => name === "get_histories")?.inputSchema).toMatchObject({
      properties: { limit: { maximum: 20, default: 5, description: "At most 20 per call; read more with pagination.next_offset" }, offset: { default: 0 } },
    });
    expect(tools.filter(tool => (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).map(tool => tool.name)).toEqual([
      "show_galaxy", "show_histories", "show_history", "show_dataset", "show_run_status",
    ]);
    expect(tools.find(tool => tool.name === "show_galaxy")?._meta).toMatchObject({
      ui: { resourceUri: HISTORY_SUMMARY_URI }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
    });
    expect(tools.find(({ name }) => name === "show_history")).toMatchObject({
      name: "show_history",
      _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI } },
    });
    expect(tools.find(({ name }) => name === "get_history_contents")?.inputSchema).toMatchObject({
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 5 },
        offset: { type: "integer", minimum: 0, default: 0 },
        historyId: { type: "string" },
        history_id: { type: "string", description: "Same as historyId" },
      },
    });
    for (const name of ["get_history_contents", "show_history"]) {
      expect(tools.find(tool => tool.name === name)?.outputSchema).toMatchObject({
        properties: {
          data: { type: "array", items: { required: ["id", "name", "state"], properties: { extension: { description: "Datasets only; collections have no format" } } } },
          pagination: { properties: { has_more: { type: "boolean" }, next_offset: { type: "integer" } } },
        },
      });
    }
    expect(tools.find(({ name }) => name === "show_run_status")).toMatchObject({
      inputSchema: { type: "object", required: ["kind"], properties: { runId: { type: "string" }, run_id: { type: "string" } }, additionalProperties: false },
      outputSchema: { type: "object", required: ["success", "run"] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI } },
    });
    expect(tools.find(({ name }) => name === "show_dataset")).toMatchObject({
      inputSchema: { type: "object", properties: { datasetId: { type: "string" }, dataset_id: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI } },
    });
    for (const name of ["get_histories", "get_history_contents", "get_run_status", "run_tool", "invoke_workflow", "get_tool_request_status", "get_invocations"]) {
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
        properties: {
          datasetId: { type: "string", minLength: 1 },
          dataset_id: { type: "string", minLength: 1 },
          maxChars: { type: "integer", minimum: 1, maximum: 50_000, default: 20_000 },
          max_chars: { type: "integer", minimum: 1, maximum: 50_000 },
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
        properties: { datasetId: { type: "string", minLength: 1 }, dataset_id: { type: "string", minLength: 1 } },
      },
      outputSchema: {
        type: "object",
        required: ["dataset_id", "url", "name", "extension", "characters_returned", "truncated"],
      },
    });
    expect(tools.find(({ name }) => name === "read_dataset_report")).toMatchObject({
      inputSchema: { type: "object", properties: { datasetId: { type: "string" }, dataset_id: { type: "string" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { source_sha256: { type: "string" }, next_page: { type: "integer" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    expect(tools.find(({ name }) => name === "read_dataset_report")?._meta ?? {}).not.toHaveProperty("ui.resourceUri");
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
