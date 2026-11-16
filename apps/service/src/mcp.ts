import { randomUUID } from "node:crypto";
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
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { HISTORY_SUMMARY_URI, registerHistorySummaryResource } from "./history-summary-ui.js";
import { authenticatedGalaxies, connectionSource, createRequestGalaxyContext, galaxySource, instanceInput, sourceOutput, withGalaxy, type GalaxyConnection } from "./galaxy-connection.js";
import { readRunStatus } from "./run-status.js";
import { registerReportReader } from "./report-reader.js";
import { registerCollections } from "./collections.js";
import { registerLocalUpload } from "./local-upload.js";
import { historyPurposeInput, recordHistoryPurpose, recordRunPurpose, runPurposeInput } from "./run-purpose.js";
import { registerRunEvents } from "./events.js";
import type { EventRequest } from "@galaxy-mcp-service/protocol";

export type { GalaxyConnection } from "./galaxy-connection.js";

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

// Public catalogs/URL fetches are not private-account reads. Generic execution can
// also run installed tools or workflow steps that contact external services.
const openWorldOperations = new Set([
  "get_server_info", "search_tools_by_name", "get_tool_details", "get_tool_citations",
  "get_tool_run_examples", "get_tool_input_template", "upload_file_from_url", "run_tool",
  "invoke_workflow", "search_iwc_workflows", "recommend_iwc_workflows",
  "get_iwc_workflow_details", "import_workflow_from_iwc",
]);

const historySummaryInput = z.object({
  limit: z.number().int().min(1).max(20).default(5).describe("At most 20 per call; read more with pagination.next_offset"),
  offset: z.number().int().min(0).default(0).describe("Use pagination.next_offset to read the next page"),
}).strict();
const presentationOutput = z.object({
  view_id: z.string().uuid().describe("Correlates this presentation with UI feedback; never display this handle to the user"),
  display_status: z.literal("unconfirmed"),
  message: z.string(),
});
const pageOutput = z.object({
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  returned: z.number().int().min(0),
  has_more: z.boolean(),
  next_offset: z.number().int().min(0).optional().describe("Present when has_more; pass it as offset to read the next page"),
});
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
  presentation: presentationOutput.optional(),
  pagination: pageOutput.optional(),
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
// Spelled out so an agent writing code against the result knows which fields an item may lack.
const historyContentsOutput = operationOutput.extend({
  data: z.array(z.object({
    id: z.string(),
    name: z.string(),
    state: z.string(),
    hid: z.number().int().optional(),
    history_content_type: z.string().optional().describe("dataset or dataset_collection"),
    extension: z.string().optional().describe("Datasets only; collections have no format"),
    file_size: z.number().optional().describe("Datasets only"),
    collection_type: z.string().optional().describe("Collections only, e.g. list or list:paired"),
    element_count: z.number().int().optional().describe("Collections only"),
    deleted: z.boolean().optional(),
    purged: z.boolean().optional(),
    visible: z.boolean().optional(),
  })).optional().describe("History items in the order asked for, each a dataset or a collection"),
  order: z.enum(["oldest", "newest"]).optional().describe("The order of data, by history number"),
  history_id: z.string().optional(),
  history_name: z.string().optional().describe("On the first page"),
  history_url: z.string().optional(),
  pagination: pageOutput.optional(),
});
const runStatusInput = z.object({
  kind: z.enum(["tool", "workflow"]).describe("The kind of previously submitted analysis"),
  runId: z.string().trim().min(1).max(512).describe("The existing tool-request or workflow-invocation handle; never a history or job id"),
}).strict();
const runStatusOutput = z.object({
  success: z.boolean(),
  presentation: presentationOutput.optional(),
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
  url: z.string().url(),
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

function withPresentation(result: CallToolResult): CallToolResult {
  if (result.isError || !result.structuredContent) return result;
  return { ...result, ...structured({
    ...result.structuredContent,
    presentation: {
      view_id: randomUUID(),
      display_status: "unconfirmed",
      message: "Display requested; visibility unconfirmed. UI feedback is scoped to this view_id, not other requests. Report evidence is read separately.",
    },
  }) };
}

function context(connection: GalaxyConnection, signal: AbortSignal) {
  return createRequestGalaxyContext(connection, signal);
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

function historyItemSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
    throw new Error("Galaxy returned an invalid history item.");
  }
  const item = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    id: item.id,
    name: typeof item.name === "string" ? item.name : "Untitled dataset",
    state: typeof item.state === "string" ? item.state : "unknown",
  };
  for (const key of ["hid", "history_content_type", "collection_type", "element_count", "deleted", "purged", "visible", "file_size"]) {
    if (["string", "number", "boolean"].includes(typeof item[key])) summary[key] = item[key];
  }
  const extension = item.extension ?? item.file_ext;
  if (typeof extension === "string") summary.extension = extension;
  return summary;
}

async function runHistoryContents(args: Record<string, unknown>, connection: GalaxyConnection, signal: AbortSignal): Promise<CallToolResult> {
  const { query, extension } = args;
  const searching = typeof query === "string" || typeof extension === "string";
  const limit = Number(args.limit);
  const offset = Number(args.offset);
  let nextOffset = offset;
  let hasMore = false;
  const data: Record<string, unknown>[] = [];
  // Bound lookup to 500 inspected items per call; next_offset resumes larger histories.
  const scanLimit = searching ? 500 : limit;
  const galaxy = context(connection, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  // As Galaxy's history panel: hidden and deleted items are listed only when asked for.
  const deleted = args.deleted === true;
  const visible = args.visible !== false;
  const order = args.order === "newest" ? "newest" : "oldest";
  const scope = `${visible ? "visible" : "hidden"}, ${deleted ? "deleted" : "non-deleted"} items`;
  // The first page also names its history, so a card opened straight on it can say which one.
  const named = offset === 0
    ? galaxy.client.GET("/api/histories/{history_id}", {
      params: { path: { history_id: String(args.historyId) }, query: { keys: "name" } },
    }).catch(() => undefined)
    : undefined;
  try {
    do {
      const pageSize = searching ? Math.min(100, scanLimit - (nextOffset - offset)) : limit;
      // Galaxy's legacy endpoint ignores pagination; v=dev also requires q/qv for boolean filters.
      const result = await galaxy.client.GET("/api/histories/{history_id}/contents", {
        params: {
          path: { history_id: String(args.historyId) },
          query: { v: "dev", order: order === "newest" ? "hid-dsc" : "hid-asc", offset: nextOffset, limit: pageSize + 1,
            q: ["deleted", "visible"], qv: [String(deleted), String(visible)] },
        },
      });
      if (result.error) return structured({ success: false, message: "Galaxy could not return this history page; no completeness claim can be made." });
      if (!Array.isArray(result.data) || result.data.length > pageSize + 1) return toolError("Galaxy did not return a bounded history page. Pagination cannot be verified.");
      const page = result.data;
      hasMore = page.length > pageSize;
      for (const [index, value] of page.slice(0, pageSize).entries()) {
        const item = historyItemSummary(value);
        nextOffset += 1;
        const matches = (typeof query !== "string" || String(item.name).toLowerCase().includes(query.toLowerCase()))
          && (typeof extension !== "string" || String(item.extension ?? "").toLowerCase() === extension.toLowerCase());
        if (matches) data.push(item);
        if (data.length === limit) {
          hasMore = index + 1 < page.length;
          break;
        }
      }
    } while (searching && hasMore && data.length < limit && nextOffset - offset < scanLimit);
  } catch {
    return toolError("Galaxy history lookup could not be completed. No absence or completeness claim can be made; retry this range.");
  }
  const complete = offset === 0 && !hasMore;
  const historyName = ((await named)?.data as { name?: unknown } | undefined)?.name;
  return structured({
    success: true,
    data,
    order,
    history_id: args.historyId,
    ...(typeof historyName === "string" && { history_name: historyName }),
    history_url: new URL(`histories/view?id=${encodeURIComponent(String(args.historyId))}`, `${connection.baseUrl.replace(/\/$/, "")}/`).href,
    filters: { query, extension, deleted, visible },
    message: searching
      ? `${data.length} matches in ${nextOffset - offset} inspected ${scope}. ${complete ? `All ${scope} of the history were searched.` : "This is a partial search, not proof of absence or uniqueness."} Multiple matches are candidates, not an automatic selection.`
      : `${data.length} ${scope} returned, ${order} first. ${complete ? `These are all ${scope} of the history.` : "This is a history page, not the whole history."} Listing an item does not open its report.`,
    ...(searching && { search: { query, extension, scanned: nextOffset - offset, complete } }),
    pagination: {
      offset, limit, returned: data.length, has_more: hasMore,
      ...(hasMore && { next_offset: nextOffset }),
    },
  });
}

async function showDataset(datasetId: string, connection: GalaxyConnection | undefined, signal: AbortSignal): Promise<CallToolResult> {
  if (!connection) return toolError("Connect a Galaxy account before using this tool.");
  const operation = productOperations.find(({ name }) => name === "get_dataset_details")!;
  const result = await runWithEnvelope(operation, { datasetId }, context(connection, signal));
  if (!result.success) return structured(result);
  try {
    const item = historyItemSummary(result.data);
    if (item.state !== "ok" || item.deleted === true || item.purged === true) {
      return toolError("The viewer opens only completed, non-deleted datasets.");
    }
    const url = new URL(`datasets/${encodeURIComponent(datasetId)}/display`, `${connection.baseUrl.replace(/\/$/, "")}/`).href;
    return structured({
      success: true, view: "dataset", data: [item], url,
      message: "Report display requested; visibility unconfirmed. The Galaxy link may require sign-in. Read evidence with get_dataset_text or read_dataset_report.",
    });
  } catch {
    return toolError("Galaxy returned incomplete report metadata.");
  }
}

async function runHistorySummary(
  limit: number,
  offset: number,
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
    const values = await getHistories({ limit: limit + 1, offset }, context(connection, signal));
    if (!Array.isArray(values) || values.length > limit + 1) throw new Error("Unbounded histories response");
    const histories = values.slice(0, limit).map(historySummary);
    if (histories.some(value => value === undefined)) throw new Error("Invalid history summary");
    const hasMore = values.length > limit;
    return structured({
      status: "connected" as const,
      instance,
      message: histories.length === 0 ? "No histories on this page." : `${histories.length} histories returned.${hasMore ? " More histories are available." : ""}`,
      histories,
      pagination: { offset, limit, returned: histories.length, has_more: hasMore, ...(hasMore && { next_offset: offset + histories.length }) },
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
    url: new URL(`datasets/${encodeURIComponent(datasetId)}/display`, `${connection.baseUrl.replace(/\/$/, "")}/`).href,
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
  if (operation.name === "get_history_contents") return runHistoryContents(args, connection, signal);
  if (operation.name === "run_tool" && typeof args.purpose === "string") {
    const { purpose, ...run } = args;
    const galaxy = context(connection, signal);
    const submitted = await runWithEnvelope(operation, run, galaxy);
    const { toolRequestId, historyId } = (submitted.data ?? {}) as { toolRequestId?: unknown; historyId?: unknown };
    if (!submitted.success || typeof toolRequestId !== "string") return structured(submitted);
    const annotated = await recordRunPurpose(purpose, toolRequestId, typeof historyId === "string" ? historyId : undefined, galaxy);
    const outcome = annotated ? `Purpose saved on ${annotated} output(s).`
      : annotated === null ? "Galaxy had not created the outputs yet, so the purpose was not saved." : "The purpose could not be saved on the outputs.";
    return structured({ ...submitted, purpose_recorded: Boolean(annotated), message: `${submitted.message ?? ""} ${outcome}`.trim() });
  }
  if (operation.name === "create_history" && typeof args.purpose === "string") {
    const { purpose, ...history } = args;
    const galaxy = context(connection, signal);
    const created = await runWithEnvelope(operation, history, galaxy);
    const historyId = (created.data as { id?: unknown } | undefined)?.id;
    if (!created.success || typeof historyId !== "string") return structured(created);
    const recorded = await recordHistoryPurpose(purpose, historyId, galaxy);
    return structured({ ...created, purpose_recorded: recorded,
      message: `${created.message ?? ""} ${recorded ? "Purpose saved as the history's annotation." : "The purpose could not be saved."}`.trim() });
  }
  const result = await runWithEnvelope(operation, args, context(connection, signal));
  if (operation.name === "get_history_details") {
    if (!result.success) return toolError(result.message ?? "Galaxy did not return history details.");
    const history = historyDetailsOutput.safeParse(result.data);
    return history.success ? structured(history.data) : toolError("Galaxy returned incomplete history details.");
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

function operationInputSchema(operation: AnyOperation, name: string = operation.name) {
  const input = { ...operation.input };
  if (operation.name === "get_history_contents") {
    input.deleted = z.boolean().default(false).describe("true lists the deleted items instead");
    input.visible = z.boolean().default(true).describe("false lists the hidden items instead, such as the datasets inside a collection or made by a run over one");
    // The card reads like Galaxy's history panel; a lookup keeps its offsets while a run adds items.
    input.order = z.enum(["oldest", "newest"]).default(name === "show_history" ? "newest" : "oldest").describe("By history number. Offsets from an oldest-first listing stay valid while a run adds items.");
    input.limit = z.number().int().min(1).max(100).default(5).describe("Maximum returned items or matches; the card initially shows 5. Check pagination before whole-history claims.");
    input.offset = z.number().int().min(0).default(0).describe("Offset from pagination.next_offset for the next page");
    input.query = z.string().trim().min(1).max(200).optional().describe("Case-insensitive name substring; scans at most 500 items per call. Keep this filter when resuming next_offset.");
    input.extension = z.string().trim().min(1).max(30).optional().describe("Exact format filter, e.g. html, txt or tabular; can be combined with query.");
  } else if (["search_tools_by_name", "search_iwc_workflows"].includes(operation.name)) {
    input.query = z.string().trim().min(1).describe("Non-empty search query");
    input.limit = z.number().int().min(1).max(50).default(20).describe("Maximum matches to return");
  } else if (operation.name === "list_workflows") {
    input.limit = z.number().int().min(1).max(100).default(50).describe("Maximum workflows to return");
  } else if (operation.name === "run_tool") {
    input.purpose = runPurposeInput;
  } else if (operation.name === "create_history") {
    input.purpose = historyPurposeInput;
  } else if (operation.name === "upload_file_from_url") {
    input.url = z
      .string()
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "URL must use HTTP or HTTPS");
  }
  return z.object(input).strict();
}

const snakeCase = (name: string) => name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/**
 * The schema with each camelCase parameter also accepted under its snake_case name, and a
 * mapping back to the camelCase names. A required parameter becomes optional in the schema,
 * since either name may carry it; the mapping reports it when both are missing.
 */
function withSnakeCaseNames(schema: z.ZodObject) {
  const shape: Record<string, z.ZodType> = { ...schema.shape };
  const aliases = new Map<string, string>();
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema.shape)) {
    const alias = snakeCase(name);
    if (alias === name || alias in shape) continue;
    if (!field.safeParse(undefined).success) {
      required.push(name);
      shape[name] = field.optional();
    }
    shape[alias] = (field instanceof z.ZodDefault ? field.unwrap() : field).optional().describe(`Same as ${name}`);
    aliases.set(alias, name);
  }
  return {
    schema: aliases.size ? z.object(shape).strict() : schema,
    toCamelCase(args: Record<string, unknown>): Record<string, unknown> | string {
      const named = { ...args };
      for (const [alias, name] of aliases) {
        if (named[alias] === undefined) continue;
        // The alias wins: a default may already have filled in the camelCase name.
        named[name] = named[alias];
        delete named[alias];
      }
      const missing = required.filter(name => named[name] === undefined);
      return missing.length
        ? `Missing ${missing.map(name => `${name} (or ${snakeCase(name)})`).join(", ")}. No Galaxy request was sent.`
        : named;
    },
  };
}

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => CallToolResult | Promise<CallToolResult>;

/**
 * Agents often call these tools with Galaxy's own snake_case names, history_id for historyId,
 * so every tool registered on this server accepts both. Handlers still see camelCase names.
 */
function acceptSnakeCaseNames(server: McpServer): void {
  const register = server.registerTool.bind(server) as (name: string, config: { inputSchema?: unknown }, handler: ToolHandler) => unknown;
  server.registerTool = ((name: string, config: { inputSchema?: unknown }, handler: ToolHandler) => {
    if (!(config.inputSchema instanceof z.ZodObject)) return register(name, config, handler);
    const { schema, toCamelCase } = withSnakeCaseNames(config.inputSchema);
    return register(name, { ...config, inputSchema: schema }, (args, ctx) => {
      const named = toCamelCase(args);
      return typeof named === "string" ? toolError(named) : handler(named, ctx);
    });
  }) as McpServer["registerTool"];
}

function registerGalaxyOperation(server: McpServer, operation: AnyOperation, connections: GalaxyConnection[], name = operation.name): void {
  const readOnly = operation.readOnly !== false;
  const rendersHistoryContents = name === "show_history";
  server.registerTool(
    name,
    {
      title: name.replaceAll("_", " "),
      description: operation.name === "get_history_contents"
        ? (rendersHistoryContents ? "Show one interactive history card for user browsing; prefer this over separate cards for each dataset. " : "Read history data without creating a card. Use for intermediate lookups and report discovery; show_history is the separate presentation action. ") + "Return compact dataset/collection summaries or find candidates by name/format. Hidden and deleted items are left out unless asked for, as in Galaxy's history panel. Filtered lookup inspects at most 500 items per call; continue from pagination.next_offset with the same filters. A partial or empty page does not prove absence or uniqueness. Use show_dataset only when a standalone report card is needed."
        : operation.name === "get_dataset_details"
          ? "Read a known dataset's metadata and Galaxy-generated peek summary when available. Useful for binary, oversized or specialized datatypes. This is not full-file evidence; use read_dataset_report for supported content or open the original in Galaxy."
          : name === "run_tool" ? `${operation.summary} Give purpose, a few words on why, so the reason is saved on the outputs.`
            : name === "create_history" ? `${operation.summary} Give purpose, a few words on why, so the reason is saved as its annotation.`
            : operation.summary,
      inputSchema: operationInputSchema(operation, name).extend(instanceInput),
      outputSchema: (operation.name === "get_history_details" ? historyDetailsOutput
        : operation.name === "get_history_contents" ? historyContentsOutput : operationOutput).extend(sourceOutput),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: operation.destructive === true,
        idempotentHint: readOnly,
        openWorldHint: openWorldOperations.has(operation.name),
      },
      ...(rendersHistoryContents && {
        _meta: {
          ui: { resourceUri: HISTORY_SUMMARY_URI },
          "openai/toolInvocation/invoking": "Loading history contents…",
          "openai/toolInvocation/invoked": "History contents loaded.",
        },
      }),
    },
    async ({ instance, ...args }, ctx) => withGalaxy(instance as string | undefined, connections, async connection => {
      const result = await runGalaxyOperation(operation, args, connection, ctx.mcpReq.signal);
      return rendersHistoryContents ? withPresentation(result) : result;
    }),
  );
}

export function createGalaxyMcpHandler(
  onerror: (error: Error) => void,
  galaxy?: GalaxyConnection,
  uiDomain?: string,
  createManagementLink?: (token: string, signal?: AbortSignal) => Promise<{ url: string; expiresIn: number }>,
  eventRequest?: EventRequest,
  authOrigin?: string,
): McpHttpHandler {
  return createMcpHandler(
    ({ authInfo }) => {
      const connections = authInfo === undefined ? (galaxy ? [galaxy] : []) : authenticatedGalaxies(authInfo);
      const server = new McpServer({
        name: "galaxy-mcp-service", version: "0.4.0",
        // The same mark as the cards, so clients don't fall back to another site's favicon.
        ...(uiDomain && { icons: [{ src: `${uiDomain}/favicon.png`, mimeType: "image/png", sizes: ["256x256"] }] }),
      }, {
        instructions: "Galaxy tools work without UI. Use get_galaxy_connections; keep instance with handles. No transfers without consent. Reads are card-free. show_galaxy opens a panel; prefer controls or one show_* per reply, never per poll. Display is unconfirmed. Read evidence: get_dataset_text or read_dataset_report. Use names, disclose gaps. Inspect inputs; submit once, monitor. Events are opt-in for an existing run, not result validation. Management links on request. Confirm destructive actions. Never expose credentials.",
      });
      acceptSnakeCaseNames(server);

      registerHistorySummaryResource(server, uiDomain, authOrigin, [...new Set(connections.map(connection => new URL(connection.baseUrl).origin))]);
      server.registerTool("get_galaxy_connections", {
        title: "Connected Galaxy sites",
        description: "List only the Galaxy instances authorized for this connection, with their routing aliases and URLs; no credentials. Select an instance explicitly on every call when more than one is connected. Histories and identifiers belong to their source site; this does not transfer data between sites.",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ connections: z.array(galaxySource) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, () => structured({ connections: connections.map(connectionSource) }));
      server.registerTool("show_galaxy", {
        title: "Galaxy workspace",
        description: "Open the Galaxy panel to browse authorized sites, histories and reports without adding a card for each lookup. Can also open an existing analysis using kind and runId together. Never submits an analysis. Clients without Plugin Extensions can use the same MCP Apps view or the read-only tools.",
        inputSchema: z.object({ ...instanceInput, kind: runStatusInput.shape.kind.optional(), runId: runStatusInput.shape.runId.optional() }).strict(),
        outputSchema: z.object({ view: z.literal("workspace"), connections: z.array(galaxySource), initial: z.unknown().optional(), management_available: z.boolean(), presentation: presentationOutput.optional() }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } },
      }, async ({ instance, kind, runId }, ctx) => {
        if ((kind === undefined) !== (runId === undefined)) return toolError("Supply both kind and runId for an existing analysis, or neither to browse histories.");
        let initial: unknown;
        if (instance !== undefined || connections.length === 1 || kind !== undefined) {
          const result = await withGalaxy(instance, connections, async connection => {
            if (!connection) return toolError("Connect Galaxy before opening an analysis.");
            return kind !== undefined && runId !== undefined
              ? structured(await readRunStatus(kind, runId, context(connection, AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(30000)]))))
              : runHistorySummary(5, 0, connection, ctx.mcpReq.signal);
          });
          if (result.isError) return result;
          initial = result.structuredContent;
        }
        return withPresentation(structured({ view: "workspace", connections: connections.map(connectionSource),
          ...(initial !== undefined ? { initial } : {}), management_available: authInfo !== undefined && createManagementLink !== undefined }));
      });
      if (authInfo !== undefined && createManagementLink !== undefined) server.registerTool(
        "get_connection_management_link",
        {
          title: "Manage Galaxy connections",
          description: "Create a one-time link, valid for five minutes, for the user to view or disconnect Galaxy sites authorized by this plugin identity. Use only when the user asks to manage, remove, rotate or revoke a connection. Creating the link changes no Galaxy access by itself.",
          inputSchema: z.object({}).strict(),
          outputSchema: z.object({ url: z.string().url(), expires_in: z.number().int().positive(), message: z.string() }),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (_input, ctx) => {
          try {
            const link = await createManagementLink(authInfo.token, ctx.mcpReq.signal);
            return structured({
              url: link.url,
              expires_in: link.expiresIn,
              message: "Open this private link within five minutes. It requires confirmation and does not use a browser login cookie.",
            });
          } catch {
            return toolError("Connection management is temporarily unavailable. No authorization was changed.");
          }
        },
      );
      for (const name of ["get_histories", "show_histories"]) server.registerTool(
        name,
        {
          title: name === "show_histories" ? "Show Galaxy histories" : "Read Galaxy histories",
          description: name === "show_histories"
            ? "Show one interactive history selector, initially five histories, with Load more / Load less. Use when the user needs to browse or choose a history, not for intermediate lookups. Display remains unconfirmed."
            : "Read a bounded page of recent histories without creating a card. Defaults to five; continue with pagination.next_offset. Use show_histories only when a user-facing selector is needed.",
          inputSchema: historySummaryInput.extend(instanceInput),
          outputSchema: historySummaryOutput.extend(sourceOutput),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          ...(name === "show_histories" && { _meta: {
            ui: { resourceUri: HISTORY_SUMMARY_URI },
            "openai/toolInvocation/invoking": "Loading Galaxy histories…",
            "openai/toolInvocation/invoked": "Galaxy histories loaded.",
          } }),
        },
        ({ instance, limit, offset }, ctx) => withGalaxy(instance, connections, async connection => {
          const result = await runHistorySummary(limit, offset, connection, ctx.mcpReq.signal);
          return name === "show_histories" ? withPresentation(result) : result;
        }),
      );

      for (const operation of productOperations) {
        registerGalaxyOperation(server, operation, connections);
        if (operation.name === "get_history_contents") registerGalaxyOperation(server, operation, connections, "show_history");
      }
      server.registerTool(
        "show_dataset",
        {
          title: "Request Galaxy report display",
          description: "Request a viewer for a known completed dataset: HTML, PDF, images, tables or text. Unsupported/binary files retain their metadata and original Galaxy link. Resolve ambiguous names first. Success means display requested, never opened/shown/visible. UI feedback must match this result's presentation.view_id and still does not prove visibility. Read evidence separately with get_dataset_text or read_dataset_report.",
          inputSchema: z.object({ datasetId: z.string().trim().min(1).max(512), ...instanceInput }).strict(),
          outputSchema: operationOutput.extend(sourceOutput),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          _meta: { ui: { resourceUri: HISTORY_SUMMARY_URI }, "openai/toolInvocation/invoked": "Display requested." },
        },
        ({ instance, datasetId }, ctx) => withGalaxy(instance, connections, async connection => withPresentation(await showDataset(datasetId, connection, ctx.mcpReq.signal))),
      );
      for (const name of ["get_run_status", "show_run_status"]) server.registerTool(
        name,
        {
          title: "Galaxy run status",
          description: (name === "show_run_status" ? "Show one status card for an existing analysis when the user needs visible progress; it can refresh in place. " : "Read an existing analysis status without creating a card. Use for background monitoring and verification; show_run_status is the separate presentation action. ") + "Refreshing never submits, cancels, or retries an analysis. Completed means execution succeeded, not that the scientific result has been validated.",
          inputSchema: runStatusInput.extend(instanceInput),
          outputSchema: runStatusOutput.extend(sourceOutput),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          ...(name === "show_run_status" && { _meta: {
            ui: { resourceUri: HISTORY_SUMMARY_URI },
            "openai/toolInvocation/invoking": "Checking analysis progress…",
            "openai/toolInvocation/invoked": "Analysis status checked.",
          } }),
        },
        ({ instance, kind, runId }, ctx) => withGalaxy(instance, connections, async connection => {
          if (connection === undefined) return structured({
            success: false,
            run: {
              kind, id: runId, name: kind === "tool" ? "Galaxy tool run" : "Galaxy workflow",
              state: "unknown", checked_at: new Date().toISOString(),
              message: "Connect a Galaxy account to check this analysis. No new analysis was submitted.",
            },
          });
          const signal = AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(30_000)]);
          const result = structured(await readRunStatus(kind, runId, context(connection, signal)));
          return name === "show_run_status" ? withPresentation(result) : result;
        }),
      );
      server.registerTool(
        "get_dataset_text",
        {
          title: "get dataset text",
          description:
            "Read bounded machine-readable text from a completed analysis result. After get_history_contents, use this on FastQC RawData or another txt/tabular/csv/tsv output before judging the result; do not use it on raw sequencing inputs.",
          inputSchema: datasetTextInput.extend(instanceInput),
          outputSchema: datasetTextOutput.extend(sourceOutput),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        ({ instance, datasetId, maxChars }, ctx) => withGalaxy(instance, connections, connection => runDatasetText(datasetId, maxChars, connection, ctx.mcpReq.signal)),
      );
      server.registerTool(
        "get_dataset_html",
        {
          title: "get dataset HTML",
          description: "Load a completed HTML analysis report for a static, non-executable card preview; the original report is available through its Galaxy link.",
          inputSchema: datasetHtmlInput.extend(instanceInput),
          outputSchema: datasetHtmlOutput.extend(sourceOutput),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: { ui: { visibility: ["app"] } },
        },
        ({ instance, datasetId }, ctx) => withGalaxy(instance, connections, connection => runDatasetHtml(datasetId, connection, ctx.mcpReq.signal)),
      );
      registerReportReader(server, connections);
      registerCollections(server, connections);
      registerLocalUpload(server, connections);
      if (authInfo !== undefined && eventRequest !== undefined && connections.length) registerRunEvents(server, authInfo, connections, eventRequest);
      return server;
    },
    { legacy: "stateless", onerror },
  );
}
