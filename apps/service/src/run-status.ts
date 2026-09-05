import { getInvocations, getToolDetails, getToolRequestStatus, type GalaxyContext } from "@galaxyproject/galaxy-ops";

export type RunKind = "tool" | "workflow";
export type RunState = "accepted" | "queued" | "running" | "completed" | "failed" | "cancelled" | "empty" | "unknown";
export interface RunStatus {
  kind: RunKind;
  id: string;
  name: string;
  state: RunState;
  checked_at: string;
  history_id?: string;
  message?: string;
  jobs?: { completed: number; failed: number; running: number; queued: number; other: number; total: number };
}

const messages: Record<RunState, string> = {
  accepted: "Accepted by Galaxy; jobs are being prepared.",
  queued: "Waiting for jobs to start or for remaining steps to be prepared.",
  running: "Analysis is running. Refresh to check its latest state.",
  completed: "All analysis jobs completed successfully. Open the results to review their findings.",
  failed: "Galaxy reported a failed job or step. Other jobs may still be running; inspect the results before considering a new run.",
  cancelled: "The run was cancelled or its jobs were stopped or deleted.",
  empty: "No analysis jobs ran. This is not evidence of a successful analysis.",
  unknown: "The run state could not be confirmed. Refresh this existing run; do not submit it again.",
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function countJobs(states: Record<string, unknown>): NonNullable<RunStatus["jobs"]> {
  const counts = { completed: 0, failed: 0, running: 0, queued: 0, other: 0, total: 0 };
  for (const [state, count] of Object.entries(states)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Invalid job counts");
    counts.total += count;
    if (state === "ok") counts.completed += count;
    else if (["error", "failed"].includes(state)) counts.failed += count;
    else if (state === "running") counts.running += count;
    else if (["new", "resubmitted", "upload", "waiting", "queued"].includes(state)) counts.queued += count;
    else counts.other += count;
  }
  if (!Number.isSafeInteger(counts.total)) throw new Error("Invalid job total");
  return counts;
}

function jobState(states: Record<string, number>, counts: NonNullable<RunStatus["jobs"]>, populated: boolean): RunState {
  if (counts.failed) return "failed";
  if (counts.running) return "running";
  if (counts.queued) return "queued";
  if ((states.deleted ?? 0) + (states.stopped ?? 0) > 0) return "cancelled";
  if (counts.other > (states.skipped ?? 0)) return "unknown";
  if (!populated) return counts.total ? "queued" : "accepted";
  return counts.completed ? "completed" : "empty";
}

function jobFailureMessage(value: unknown): string | undefined {
  const job = object(value);
  // Only use already-returned fatal descriptions; regex matches and stderr can contain full logs.
  for (const value of Array.isArray(job.job_messages) ? job.job_messages.slice(0, 10) : []) {
    const message = object(value);
    if (typeof message.type !== "string" || !["exit_code", "regex", "max_discovered_files"].includes(message.type)
      || typeof message.error_level !== "number" || ![3, 4].includes(message.error_level)) continue;
    const description = text(message.desc) ?? text(message.code_desc);
    if (description) return description.slice(0, 400);
    if (message.error_level === 4) return "A job exceeded its available memory.";
    if (message.type === "max_discovered_files") return "A job produced more output files than Galaxy allows.";
  }
  if (typeof job.exit_code === "number" && Number.isSafeInteger(job.exit_code) && job.exit_code !== 0) {
    return `A job exited with code ${job.exit_code}.`;
  }
  return undefined;
}

async function readTool(run: RunStatus, ctx: GalaxyContext): Promise<void> {
  const status = await getToolRequestStatus({ toolRequestId: run.id }, ctx);
  const states: Record<string, number> = {};
  let failureReason: string | undefined;
  for (const job of status.jobs) {
    states[job.state] = (states[job.state] ?? 0) + 1;
    if (["error", "failed"].includes(job.state)) failureReason ??= jobFailureMessage(job);
  }
  run.jobs = countJobs(states);
  run.state = status.requestState === "failed" ? "failed"
    : ["new", "submitted"].includes(status.requestState) ? jobState(states, run.jobs, status.requestState === "submitted")
      : "unknown";
  if (run.state === "failed") {
    const reason = text(status.stateMessage) ?? text(object(status.stateMessage).err_msg) ?? failureReason;
    if (reason) run.message = reason.slice(0, 800);
  }
  const firstJob = status.jobs[0];
  let toolId = text(firstJob?.tool_id);
  const historyId = text(firstJob?.history_id);
  if (historyId) run.history_id = historyId;
  // A new or empty tool request has no job metadata yet. These lookups only improve its label/link.
  try {
    if (!toolId || !run.history_id) {
      const detail = await ctx.client.GET("/api/tool_requests/{id}", { params: { path: { id: run.id } } });
      if (!detail.error && detail.data) {
        toolId ??= text(detail.data.request?.tool_id);
        const requestedHistory = text(detail.data.request?.history_id);
        if (!run.history_id && requestedHistory) run.history_id = requestedHistory;
      }
    }
    if (toolId) {
      const details = await getToolDetails({ toolId }, ctx);
      run.name = text(details.name) ?? run.name;
    }
  } catch { /* A missing label must not turn a confirmed job state into a failed query. */ }
}

async function readWorkflow(run: RunStatus, ctx: GalaxyContext): Promise<void> {
  const invocation = await getInvocations({ invocationId: run.id }, ctx);
  if (invocation.id !== run.id || !["new", "requires_materialization", "ready", "scheduled", "cancelled", "cancelling", "failed", "completed"].includes(invocation.state)) {
    throw new Error("Galaxy did not return a valid invocation");
  }
  const historyId = text(invocation.history_id);
  if (historyId) run.history_id = historyId;
  try {
    if (text(invocation.workflow_id)) {
      // Invocation workflow_id is the Workflow instance, not its StoredWorkflow id.
      const details = await ctx.client.GET("/api/workflows/{workflow_id}", {
        params: { path: { workflow_id: invocation.workflow_id }, query: { instance: true } },
      });
      if (!details.error && details.data) run.name = text(details.data.name) ?? run.name;
    }
  } catch { /* Names are optional; the invocation and its own jobs determine status. */ }
  if (invocation.state === "cancelled" || invocation.state === "failed") {
    run.state = invocation.state;
    const reasons = (invocation.messages ?? []).slice(0, 3).map((value) => {
      const message = object(value);
      const reason = text(message.reason)?.replaceAll("_", " ");
      const details = text(message.details);
      return [reason, details].filter(Boolean).join(": ");
    }).filter(Boolean);
    if (reasons.length) run.message = reasons.join("; ").slice(0, 800);
    return;
  }
  const summary = await ctx.client.GET("/api/invocations/{invocation_id}/jobs_summary", {
    params: { path: { invocation_id: run.id } },
  });
  if (summary.error || !summary.data || !summary.data.states || typeof summary.data.states !== "object" || Array.isArray(summary.data.states)) {
    throw new Error("Galaxy did not return invocation job states");
  }
  run.jobs = countJobs(summary.data.states);
  // 'scheduled' and populated_state='ok' only say expansion finished, not that jobs succeeded.
  const populated = ["scheduled", "completed"].includes(invocation.state) && summary.data.populated_state === "ok";
  run.state = summary.data.populated_state === "failed" ? "failed" : jobState(summary.data.states, run.jobs, populated);
  if (invocation.state === "cancelling") {
    run.state = "running";
    run.message = "Cancellation was requested. Galaxy has not yet confirmed that the run stopped.";
  }
}

/** Read one existing run; never submit, retry execution, or infer status from unrelated history jobs. */
export async function readRunStatus(kind: RunKind, id: string, ctx: GalaxyContext): Promise<{
  success: boolean;
  run: RunStatus;
  message?: string;
}> {
  const run: RunStatus = { kind, id, name: kind === "tool" ? "Tool analysis" : "Workflow analysis", state: "unknown", checked_at: "" };
  try {
    if (kind === "tool") await readTool(run, ctx);
    else await readWorkflow(run, ctx);
    run.message ??= messages[run.state];
    run.checked_at = new Date().toISOString();
    return { success: true, run };
  } catch {
    run.state = "unknown";
    run.message = messages.unknown;
    run.checked_at = new Date().toISOString();
    delete run.jobs;
    return { success: false, run, message: messages.unknown };
  }
}
