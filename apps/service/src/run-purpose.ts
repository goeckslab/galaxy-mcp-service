import type { GalaxyContext } from "@galaxyproject/galaxy-ops";
import { z } from "zod";

// Galaxy accepts no note when a run is submitted or a history is created. So the reason is
// written afterwards as an annotation, where it stays visible in Galaxy next to the result:
// on a new history at once, on a run's outputs once Galaxy has turned the request into jobs.

const purpose = (what: string, example: string) => z.string().trim().min(1).max(120).refine(value => !/\p{Cc}/u.test(value), "One line").optional()
  .describe(`Why ${what}, in a few words, e.g. '${example}'. Saved as an annotation so the reason stays visible in Galaxy. Anyone the history is shared with can read it: state the analysis purpose only, no personal details.`);
export const runPurposeInput = purpose("this run is submitted", "Check read quality before trimming");
export const historyPurposeInput = purpose("this history is created", "Compare liver and kidney expression");
const note = (text: string) => `AI assistant: ${text}`;

/** Annotate a new history with its purpose. A failure never undoes or fails the creation. */
export async function recordHistoryPurpose(text: string, historyId: string, ctx: GalaxyContext): Promise<boolean> {
  try {
    const updated = await ctx.client.PUT("/api/histories/{history_id}", { params: { path: { history_id: historyId } }, body: { annotation: note(text) } });
    return !updated.error;
  } catch { return false; }
}

/** Mapping a tool over a collection can create hundreds of jobs; only the first ones are annotated. */
const MAX_JOBS = 20;
const WAIT_MS = 10_000;
const POLL_MS = 500;

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
});

/**
 * Annotate the outputs of an accepted tool request with its purpose. Waits briefly for Galaxy to
 * create them and gives up quietly: the analysis itself is never delayed further, retried or
 * failed because of the note. Returns how many outputs were annotated. A collection counts only
 * when Galaxy reports the annotation back: older Galaxy servers accept the update and drop it.
 */
export async function recordRunPurpose(text: string, toolRequestId: string, ctx: GalaxyContext, waitMs = WAIT_MS): Promise<number> {
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = await ctx.client.GET("/api/tool_requests/{id}/state", { params: { path: { id: toolRequestId } } });
      if (state.error || state.data == null) return 0;
      if (String(state.data) !== "new") break;
      if (Date.now() + POLL_MS > deadline) return 0;
      await pause(POLL_MS, ctx.signal);
    }
    const detail = await ctx.client.GET("/api/tool_requests/{id}", { params: { path: { id: toolRequestId } } });
    const historyId = (detail.data?.request as { history_id?: unknown } | undefined)?.history_id;
    if (detail.error || !detail.data || typeof historyId !== "string") return 0;
    const datasets = new Set<string>();
    const collections = new Set(detail.data.implicit_collections.map(collection => collection.id));
    for (const { id } of detail.data.jobs.slice(0, MAX_JOBS)) {
      const outputs = await ctx.client.GET("/api/jobs/{job_id}/outputs", { params: { path: { job_id: id } } });
      for (const output of outputs.data ?? []) {
        if ("dataset" in output && output.dataset.src === "hda") datasets.add(output.dataset.id);
        if ("dataset_collection_instance" in output) collections.add(output.dataset_collection_instance.id);
      }
    }
    const annotate = (type: "dataset" | "dataset_collection", id: string) => ctx.client.PUT("/api/histories/{history_id}/contents/{type}s/{id}", {
      params: { path: { history_id: historyId, type, id } }, body: { annotation: note(text) },
    });
    let annotated = 0;
    for (const id of datasets) if (!(await annotate("dataset", id)).error) annotated += 1;
    for (const id of collections) {
      const updated = await annotate("dataset_collection", id);
      if ((updated.data as { annotation?: unknown } | undefined)?.annotation === note(text)) annotated += 1;
    }
    return annotated;
  } catch { return 0; }
}
