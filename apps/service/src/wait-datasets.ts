import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createRequestGalaxyContext, instanceInput, sourceOutput, withGalaxy, type GalaxyConnection } from "./galaxy-connection.js";

/**
 * Waits a bounded time for datasets to finish, so an assistant can keep going in the same turn
 * instead of asking the user to watch uploads or jobs. It only reads the history.
 */

const PENDING = new Set(["new", "upload", "queued", "running", "setting_metadata"]);
const SCAN_LIMIT = 1000;
const LISTED = 50;

const input = z.object({
  historyId: z.string().trim().min(1).max(256).describe("Encoded id of the history that holds the datasets"),
  datasetIds: z.array(z.string().trim().min(1).max(256)).min(1).max(200).optional()
    .describe("Encoded dataset ids to wait for. Omit to wait for every dataset in the history that is still processing."),
  timeoutSeconds: z.number().int().min(1).max(45).optional().describe("How long to wait in this call, 1-45 seconds; default 30"),
}).strict();
const item = z.object({ id: z.string(), hid: z.number().int().optional(), name: z.string().optional(), state: z.string() });
const output = z.object({
  success: z.boolean(),
  data: z.object({
    done: z.boolean().describe("True when nothing is still processing"),
    ready: z.number().int(),
    processing: z.number().int(),
    failed: z.number().int().describe("Datasets in error, failed_metadata or paused"),
    missing: z.array(z.string()).describe("Requested ids not found among the history's non-deleted datasets"),
    waited_seconds: z.number().int(),
    items: z.array(item).describe(`Datasets that are not ready, at most ${LISTED}`),
  }).optional(),
  message: z.string(),
});

type Item = z.infer<typeof item>;
type Summary = NonNullable<z.infer<typeof output>["data"]>;

const failedState = (state: string) => state === "error" || state === "failed_metadata" || state === "paused";

function result(value: z.infer<typeof output>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(!value.success && { isError: true }) };
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function readDatasets(historyId: string, connection: GalaxyConnection, signal: AbortSignal): Promise<Item[] | undefined> {
  const galaxy = createRequestGalaxyContext(connection, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  const response = await galaxy.client.GET("/api/histories/{history_id}/contents", {
    params: {
      path: { history_id: historyId },
      query: { v: "dev", order: "hid-dsc", limit: SCAN_LIMIT, keys: "id,hid,name,state",
        q: ["deleted", "history_content_type"], qv: ["false", "dataset"] },
    },
  }).catch(() => undefined);
  if (!response || response.error || !Array.isArray(response.data)) return undefined;
  return (response.data as Record<string, unknown>[]).flatMap((value) => typeof value.id === "string" ? [{
    id: value.id, state: typeof value.state === "string" ? value.state : "unknown",
    ...(typeof value.hid === "number" && { hid: value.hid }), ...(typeof value.name === "string" && { name: value.name }),
  }] : []);
}

function summarize(datasets: Item[], wanted: string[] | undefined, waited: number): Summary {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const chosen = wanted ? wanted.flatMap((id) => byId.get(id) ?? []) : datasets.filter((dataset) => PENDING.has(dataset.state));
  const processing = chosen.filter((dataset) => PENDING.has(dataset.state));
  const failed = chosen.filter((dataset) => failedState(dataset.state));
  return {
    done: processing.length === 0,
    ready: chosen.filter((dataset) => dataset.state === "ok").length,
    processing: processing.length,
    failed: failed.length,
    missing: wanted ? wanted.filter((id) => !byId.has(id)) : [],
    waited_seconds: waited,
    items: [...failed, ...processing, ...chosen.filter((d) => d.state !== "ok" && !PENDING.has(d.state) && !failedState(d.state))].slice(0, LISTED),
  };
}

function message(summary: Summary, everything: boolean): string {
  const missing = summary.missing.length ? ` ${summary.missing.length} requested id(s) were not found in this history.` : "";
  if (!summary.done) {
    return `${summary.processing} dataset(s) still processing after ${summary.waited_seconds}s.${missing} Call wait_for_datasets again to keep waiting, and continue the user's request when they are ready; do not ask the user to watch them.`;
  }
  if (summary.failed) return `Nothing is still processing, but ${summary.failed} dataset(s) failed or are paused.${missing} Inspect them with get_job_details before continuing.`;
  if (everything) return `Nothing in this history is still processing.${missing}`;
  return `All ${summary.ready} dataset(s) are ready.${missing}`;
}

async function waitForDatasets(args: z.infer<typeof input>, connection: GalaxyConnection | undefined, signal: AbortSignal, pollMs: number): Promise<CallToolResult> {
  if (connection === undefined) return result({ success: false, message: "Connect a Galaxy account before using this tool." });
  const started = Date.now();
  const deadline = started + (args.timeoutSeconds ?? 30) * 1000;
  // Without ids, keep watching the datasets that were processing at the start, so newly added ones do not extend the wait.
  let wanted = args.datasetIds;
  for (;;) {
    const datasets = await readDatasets(args.historyId, connection, signal);
    const waited = Math.round((Date.now() - started) / 1000);
    if (datasets === undefined) {
      return result({ success: false, message: "Galaxy could not return this history's datasets. Their states are unconfirmed; retry wait_for_datasets." });
    }
    wanted ??= datasets.filter((dataset) => PENDING.has(dataset.state)).map((dataset) => dataset.id);
    const summary = summarize(datasets, wanted, waited);
    if (summary.done || Date.now() + pollMs > deadline || signal.aborted) {
      return result({ success: true, data: summary, message: message(summary, args.datasetIds === undefined) });
    }
    await sleep(pollMs, signal);
  }
}

export function registerWaitForDatasets(server: McpServer, connections: GalaxyConnection[], pollMs = 3000) {
  server.registerTool("wait_for_datasets", {
    description: "Wait up to 45 seconds for uploads or tool outputs in a history to finish, then report their states. Use it after starting uploads or jobs the user asked you to run: call it again while done is false, and continue with the next step as soon as the inputs are ready, instead of asking the user to watch. Reads only; never changes Galaxy.",
    inputSchema: input.extend(instanceInput), outputSchema: output.extend(sourceOutput),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ instance, ...args }, ctx) => withGalaxy(instance, connections, (connection) => waitForDatasets(args, connection, ctx.mcpReq.signal, pollMs)));
}
