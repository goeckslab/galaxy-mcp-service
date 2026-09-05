import {
  allOperations,
  getHistories,
  runWithEnvelope,
  submitToolOp,
  type AnyOperation,
} from "@galaxyproject/galaxy-ops";
import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { HISTORY_SUMMARY_URI, registerHistorySummaryResource } from "./history-summary-ui.js";
import { createRequestGalaxyContext } from "./galaxy-connection.js";
import { readRunStatus } from "./run-status.js";

export interface GalaxyConnection {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

const productOperationNames = new Set<string>([
  "get_user",
  "get_server_info",
  "get_history_details",
  "get_history_contents",
  "create_history",
  "get_dataset_details",
  "get_collection_details",
  "upload_file_from_url",
  "search_tools_by_name",
  "get_tool_details",
  "get_tool_citations",
  "get_tool_run_examples",
  "get_tool_input_template",
  "run_tool",
  "get_tool_request_status",
  "get_job_details",
  "list_workflows",
  "get_workflow_details",
  "get_workflow_input_template",
  "invoke_workflow",
  "get_invocations",
  "cancel_workflow_invocation",
  "search_iwc_workflows",
  "recommend_iwc_workflows",
  "get_iwc_workflow_details",
  "import_workflow_from_iwc",
]);

export const productOperations = allOperations
  .filter(({ name }) => productOperationNames.has(name))
  .map((operation) => operation.name === "run_tool" ? { ...submitToolOp, name: "run_tool" } : operation);
if (productOperations.length !== productOperationNames.size) throw new Error("A configured Galaxy operation is unavailable");

const historySummaryInput = z.object({ limit: z.number().int().min(1).max(20).default(8) }).strict();
const historySummaryOutput = z.object({
  status: z.enum(["connected", "not_configured", "error"]),
  instance: z.string().optional(),
  message: z.string(),
  histories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      state: z.string(),
      update_time: z.string().optional(),
      count: z.number().int().min(0).optional(),
    }),
  ),
});
const historyDetailsOutput = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  count: z.number().int().min(0),
});
const operationOutput = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  errorKind: z.string().optional(),
}).passthrough();
const runStatusInput = z.object({
  kind: z.enum(["tool", "workflow"]).describe("The kind of previously submitted analysis"),
  runId: z.string().trim().min(1).max(512).describe("The existing tool-request or workflow-invocation handle; never a history or job id"),
}).strict();
const runStatusOutput = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  run: z.object({
    kind: z.enum(["tool", "workflow"]),
    id: z.string(),
    name: z.string(),
    state: z.enum(["accepted", "queued", "running", "completed", "failed", "cancelled", "empty", "unknown"]),
    checked_at: z.string(),
    history_id: z.string().optional(),
    message: z.string().optional(),
    jobs: z.object({
      completed: z.number().int().min(0),
      failed: z.number().int().min(0),
      running: z.number().int().min(0),
      queued: z.number().int().min(0),
      other: z.number().int().min(0),
      total: z.number().int().min(0),
    }).optional(),
  }),
});
const datasetTextInput = z
  .object({
    datasetId: z.string().trim().min(1).describe("Encoded dataset id for a text analysis result"),
    maxChars: z.number().int().min(1).max(50_000).default(20_000).describe("Maximum characters to return"),
  })
  .strict();
const datasetTextOutput = z.object({
  dataset_id: z.string(),
  name: z.string(),
  extension: z.string(),
  text: z.string().max(50_000),
  characters_returned: z.number().int().min(0),
  truncated: z.boolean(),
});
const datasetHtmlInput = z
  .object({ datasetId: z.string().trim().min(1).describe("Encoded dataset id for a completed HTML report") })
  .strict();
const datasetHtmlOutput = z.object({
  dataset_id: z.string(),
  name: z.string(),
  extension: z.literal("html"),
  characters_returned: z.number().int().min(0),
  truncated: z.boolean(),
});
const readableResultExtensions = new Set(["txt", "tabular", "csv", "tsv"]);
const MAX_HTML_CHARACTERS = 1_000_000;

function structured<T extends object>(output: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output as Record<string, unknown>,
    ...((("success" in output && output.success === false) || ("status" in output && output.status === "error")) && { isError: true }),
  };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function context(connection: GalaxyConnection, signal: AbortSignal) {
  return createRequestGalaxyContext(connection, signal);
}

function authenticatedGalaxy(authInfo?: AuthInfo): GalaxyConnection | undefined {
  const value = authInfo?.extra?.galaxy;
  if (value === null || typeof value !== "object") return undefined;
  const connection = value as Partial<GalaxyConnection>;
  return typeof connection.baseUrl === "string" && typeof connection.apiKey === "string"
    ? {
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        ...(typeof connection.fetchImpl === "function" && { fetchImpl: connection.fetchImpl }),
      }
    : undefined;
}

function instanceName(baseUrl: string): string {
  return new URL(baseUrl).host;
}

function historySummary(value: unknown): z.infer<typeof historySummaryOutput>["histories"][number] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const history = value as Record<string, unknown>;
  if (typeof history.id !== "string" || typeof history.name !== "string") return undefined;
  return {
    id: history.id,
    name: history.name,
    state: typeof history.state === "string" ? history.state : "unknown",
    ...(typeof history.update_time === "string" && { update_time: history.update_time }),
    ...(typeof history.count === "number" && Number.isInteger(history.count) && history.count >= 0 && { count: history.count }),
  };
}

async function runHistorySummary(
  limit: number,
  connection: GalaxyConnection | undefined,
  signal: AbortSignal,
): Promise<CallToolResult> {
  if (connection === undefined) {
    return structured({
      status: "not_configured" as const,
      message: "Connect a Galaxy account to show histories.",
      histories: [],
    });
  }

  const instance = instanceName(connection.baseUrl);
  try {
    const values = await getHistories({ limit }, context(connection, signal));
    const histories = (Array.isArray(values) ? values : []).map(historySummary).filter((value) => value !== undefined);
    return structured({
      status: "connected" as const,
      instance,
      message: histories.length === 0 ? "No histories found." : `${histories.length} histories found.`,
      histories,
    });
  } catch {
    return structured({
      status: "error" as const,
      instance,
      message: "Galaxy did not return histories. Check the service connection.",
      histories: [],
    });
  }
}

async function runDatasetText(
  datasetId: string,
  maxChars: number,
  connection: GalaxyConnection | undefined,
  signal: AbortSignal,
): Promise<CallToolResult> {
  if (connection === undefined) return toolError("Connect a Galaxy account before using this tool.");

  const galaxy = context(connection, signal);
  const metadataResult = await galaxy.client.GET("/api/datasets/{dataset_id}", {
    params: { path: { dataset_id: datasetId } },
  });
  if (metadataResult.error || !metadataResult.data) return toolError("Galaxy did not return dataset metadata.");

  const metadata = metadataResult.data as Record<string, unknown>;
  const state = typeof metadata.state === "string" ? metadata.state : "unknown";
  const extension = typeof metadata.file_ext === "string" ? metadata.file_ext.toLowerCase() : "";
  if (state !== "ok") return toolError(`Dataset is not ready (state=${state}).`);
  if (!readableResultExtensions.has(extension)) {
    return toolError("This action reads only txt, tabular, csv, or tsv analysis results.");
  }

  const contentResult = await galaxy.client.GET("/api/datasets/{dataset_id}/get_content_as_text", {
    params: { path: { dataset_id: datasetId } },
  });
  if (contentResult.error || !contentResult.data) return toolError("Galaxy did not return dataset text.");

  const content = contentResult.data as Record<string, unknown>;
  if (typeof content.item_data !== "string") return toolError("This dataset has no readable text content.");
  const text = content.item_data.slice(0, maxChars);
  return structured({
    dataset_id: datasetId,
    name: typeof metadata.name === "string" ? metadata.name : datasetId,
    extension,
    text,
    characters_returned: text.length,
    truncated: content.truncated === true || content.item_data.length > maxChars,
  });
}

async function runDatasetHtml(
  datasetId: string,
  connection: GalaxyConnection | undefined,
  signal: AbortSignal,
): Promise<CallToolResult> {
  if (connection === undefined) return toolError("Connect a Galaxy account before using this tool.");

  const galaxy = context(connection, signal);
  const metadataResult = await galaxy.client.GET("/api/datasets/{dataset_id}", {
    params: { path: { dataset_id: datasetId } },
  });
  if (metadataResult.error || !metadataResult.data) return toolError("Galaxy did not return dataset metadata.");

  const metadata = metadataResult.data as Record<string, unknown>;
  const state = typeof metadata.state === "string" ? metadata.state : "unknown";
  const extension = typeof metadata.file_ext === "string" ? metadata.file_ext.toLowerCase() : "";
  if (state !== "ok") return toolError(`Dataset is not ready (state=${state}).`);
  if (extension !== "html") return toolError("This action reads only completed HTML analysis reports.");

  const contentResult = await galaxy.client.GET("/api/datasets/{dataset_id}/get_content_as_text", {
    params: { path: { dataset_id: datasetId } },
  });
  if (contentResult.error || !contentResult.data) return toolError("Galaxy did not return the HTML report.");

  const content = contentResult.data as Record<string, unknown>;
  if (typeof content.item_data !== "string") return toolError("This dataset has no readable HTML content.");
  const html = content.item_data.slice(0, MAX_HTML_CHARACTERS);
  const summary = {
    dataset_id: datasetId,
    name: typeof metadata.name === "string" ? metadata.name : datasetId,
    extension: "html" as const,
    characters_returned: html.length,
    truncated: content.truncated === true || content.item_data.length > MAX_HTML_CHARACTERS,
  };
  return {
    content: [{ type: "text", text: "HTML report ready for the app viewer." }],
    structuredContent: summary,
    _meta: { html },
  };
}

async function runGalaxyOperation(
  operation: AnyOperation,
  args: Record<string, unknown>,
  connection: GalaxyConnection | undefined,
  signal: AbortSignal,
): Promise<CallToolResult> {
  if (connection === undefined) {
    if (operation.name === "get_history_details") {
      return toolError("Connect a Galaxy account before using this tool.");
    }
    return structured({
      data: null,
      success: false,
      message: "Connect a Galaxy account before using this tool.",
      errorKind: "connection",
    });
  }
  const historyPage = operation.name === "get_history_contents";
  // Ask Galaxy for one extra item so a full page is never mistaken for the whole history.
  const input = historyPage ? { ...args, limit: Number(args.limit) + 1 } : args;
  const result = await runWithEnvelope(operation, input, context(connection, signal));
  if (operation.name === "get_history_details") {
    if (!result.success) return toolError(result.message ?? "Galaxy did not return history details.");
    const history = historyDetailsOutput.safeParse(result.data);
    return history.success ? structured(history.data) : toolError("Galaxy returned incomplete history details.");
  }
  if (historyPage && result.success) {
    if (!Array.isArray(result.data)) return toolError("Galaxy returned invalid history contents.");
    const limit = Number(args.limit);
    const offset = Number(args.offset);
    const data = result.data.slice(0, limit);
    const hasMore = result.data.length > limit;
    return structured({
      success: true,
      data,
      history_id: args.historyId,
      message: `${data.length} items returned${hasMore ? "; more items are available" : ""}.`,
      pagination: {
        offset,
        limit,
        returned: data.length,
        has_more: hasMore,
        ...(hasMore && { next_offset: offset + data.length }),
      },
    });
  }
  if (Array.isArray(result.data) && typeof args.limit === "number") {
    return structured({
      ...result,
      data: result.data.slice(0, args.limit),
      pagination: {
        ...result.pagination,
        total: result.data.length,
        limit: args.limit,
        returned: Math.min(result.data.length, args.limit),
        has_more: result.data.length > args.limit,
      },
    });
  }
  return structured(result);
}

function operationInputSchema(operation: AnyOperation) {
  const input = { ...operation.input };
  if (operation.name === "get_history_contents") {
    input.limit = z.number().int().min(1).max(100).default(20).describe("Items per page; check pagination.has_more before summarizing the whole history");
    input.offset = z.number().int().min(0).default(0).describe("Offset from pagination.next_offset for the next page");
  } else if (["search_tools_by_name", "search_iwc_workflows"].includes(operation.name)) {
    input.query = z.string().trim().min(1).describe("Non-empty search query");
    input.limit = z.number().int().min(1).max(50).default(20).describe("Maximum matches to return");
  } else if (operation.name === "list_workflows") {
    input.limit = z.number().int().min(1).max(100).default(50).describe("Maximum workflows to return");
  } else if (operation.name === "upload_file_from_url") {
    input.url = z
      .string()
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "URL must use HTTP or HTTPS");
  }
  return z.object(input).strict();
}

function registerGalaxyOperation(server: McpServer, operation: AnyOperation, connection?: GalaxyConnection): void {
  const readOnly = operation.readOnly !== false;
  const rendersHistoryContents = operation.name === "get_history_contents";
  server.registerTool(
    operation.name,
    {
      title: operation.name.replaceAll("_", " "),
      description: operation.summary,
      inputSchema: operationInputSchema(operation),
      outputSchema: operation.name === "get_history_details" ? historyDetailsOutput : operationOutput,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: operation.destructive === true,
        idempotentHint: readOnly,
        openWorldHint: true,
      },
      ...(rendersHistoryContents && {
        _meta: {
          ui: { resourceUri: HISTORY_SUMMARY_URI },
          "openai/toolInvocation/invoking": "Loading history contents…",
          "openai/toolInvocation/invoked": "History contents loaded.",
        },
      }),
    },
    (args, ctx) => runGalaxyOperation(operation, args, connection, ctx.mcpReq.signal),
  );
}

export function createGalaxyMcpHandler(
  onerror: (error: Error) => void,
  galaxy?: GalaxyConnection,
): McpHttpHandler {
  return createMcpHandler(
    ({ authInfo }) => {
      const connection = authInfo === undefined ? galaxy : authenticatedGalaxy(authInfo);
      const server = new McpServer({ name: "galaxy-mcp-service", version: "0.4.0" });

      registerHistorySummaryResource(server);
      server.registerTool(
        "get_histories",
        {
          title: "Galaxy history summary",
          description: "List recent Galaxy histories and render a compact read-only summary.",
          inputSchema: historySummaryInput,
          outputSchema: historySummaryOutput,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
          _meta: {
            ui: { resourceUri: HISTORY_SUMMARY_URI },
            "openai/toolInvocation/invoking": "Loading Galaxy histories…",
            "openai/toolInvocation/invoked": "Galaxy histories loaded.",
          },
        },
        ({ limit }, ctx) => runHistorySummary(limit, connection, ctx.mcpReq.signal),
      );

      for (const operation of productOperations) registerGalaxyOperation(server, operation, connection);
      server.registerTool(
        "get_run_status",
        {
          title: "Galaxy run status",
          description: "Check an existing tool request or workflow invocation once and show a status card. Use after submission or when the user asks for visible progress. Refreshing never submits, cancels, or retries an analysis. Completed means execution succeeded, not that the scientific result has been validated.",
          inputSchema: runStatusInput,
          outputSchema: runStatusOutput,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
          _meta: {
            ui: { resourceUri: HISTORY_SUMMARY_URI },
            "openai/toolInvocation/invoking": "Checking analysis progress…",
            "openai/toolInvocation/invoked": "Analysis status checked.",
          },
        },
        async ({ kind, runId }, ctx) => {
          if (connection === undefined) return structured({
            success: false,
            run: {
              kind, id: runId, name: kind === "tool" ? "Galaxy tool run" : "Galaxy workflow",
              state: "unknown", checked_at: new Date().toISOString(),
              message: "Connect a Galaxy account to check this analysis. No new analysis was submitted.",
            },
          });
          const signal = AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(30_000)]);
          return structured(await readRunStatus(kind, runId, context(connection, signal)));
        },
      );
      server.registerTool(
        "get_dataset_text",
        {
          title: "get dataset text",
          description:
            "Read bounded machine-readable text from a completed analysis result. After get_history_contents, use this on FastQC RawData or another txt/tabular/csv/tsv output before judging the result; do not use it on raw sequencing inputs.",
          inputSchema: datasetTextInput,
          outputSchema: datasetTextOutput,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        ({ datasetId, maxChars }, ctx) => runDatasetText(datasetId, maxChars, connection, ctx.mcpReq.signal),
      );
      server.registerTool(
        "get_dataset_html",
        {
          title: "get dataset HTML",
          description: "Load a completed HTML analysis report for the sandboxed Galaxy card viewer.",
          inputSchema: datasetHtmlInput,
          outputSchema: datasetHtmlOutput,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
          _meta: { ui: { visibility: ["app"] } },
        },
        ({ datasetId }, ctx) => runDatasetHtml(datasetId, connection, ctx.mcpReq.signal),
      );
      return server;
    },
    { legacy: "stateless", onerror },
  );
}
