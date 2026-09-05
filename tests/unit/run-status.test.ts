import { describe, expect, it } from "vitest";

import { createRequestGalaxyContext } from "../../apps/service/src/galaxy-connection.js";
import { readRunStatus } from "../../apps/service/src/run-status.js";

function context(routes: Record<string, unknown | Response>) {
  const reads: string[] = [];
  const galaxy = createRequestGalaxyContext({
    baseUrl: "https://galaxy.example.test", apiKey: "fixture-secret",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      const route = `${url.pathname}${url.search}`;
      reads.push(route);
      const value = routes[route];
      if (value === undefined) return Response.json({ err_msg: "Unavailable" }, { status: 404 });
      return value instanceof Response ? value.clone() : Response.json(value);
    },
  }, new AbortController().signal);
  return { galaxy, reads };
}

describe("read-only run status", () => {
  it.each([
    ["new", [], "accepted"],
    ["submitted", ["queued"], "queued"],
    ["submitted", ["ok", "running"], "running"],
    ["submitted", ["ok", "ok"], "completed"],
    ["submitted", ["ok", "error"], "failed"],
    ["submitted", ["deleted"], "cancelled"],
    ["submitted", [], "empty"],
    ["submitted", ["skipped"], "empty"],
    ["submitted", ["paused"], "unknown"],
  ] as const)("maps tool request %s with %j jobs to %s", async (requestState, states, expectedState) => {
    const routes: Record<string, unknown> = {
      "/api/tool_requests/r1": {
        id: "r1", state: requestState, jobs: states.map((_, index) => ({ id: `j${index}` })),
        request: { tool_id: "fastqc", history_id: "h1" },
      },
      "/api/tools/fastqc?io_details=false": { name: "FastQC" },
    };
    states.forEach((state, index) => { routes[`/api/jobs/j${index}`] = { id: `j${index}`, state, tool_id: "fastqc", history_id: "h1" }; });
    const { galaxy, reads } = context(routes);
    const result = await readRunStatus("tool", "r1", galaxy);
    expect(result).toMatchObject({
      success: true,
      run: { kind: "tool", id: "r1", name: "FastQC", history_id: "h1", state: expectedState, jobs: { total: states.length } },
    });
    expect(Number.isFinite(Date.parse(result.run.checked_at))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(reads.filter((route) => route === "/api/tool_requests/r1")).toHaveLength(states.length ? 1 : 2);
  });

  it("keeps a failed status lookup unknown and preserves its request handle", async () => {
    const { galaxy, reads } = context({ "/api/tool_requests/r1": new Response("temporary outage", { status: 503 }) });
    const result = await readRunStatus("tool", "r1", galaxy);
    expect(result).toMatchObject({ success: false, run: { kind: "tool", id: "r1", state: "unknown" } });
    expect(result.run.jobs).toBeUndefined();
    expect(result.run.message).toContain("do not submit it again");
    expect(reads).toEqual(["/api/tool_requests/r1"]);
  });

  it.each(["The input collection could not be expanded.", { err_msg: "The input collection could not be expanded." }])("keeps a genuine rejection with reason %j distinct from an unavailable query or optional label", async (reason) => {
    const { galaxy } = context({
      "/api/tool_requests/r1": {
        id: "r1", state: "failed", jobs: [], request: { tool_id: "removed-tool", history_id: "h1" },
        state_message: reason,
      },
    });
    expect(await readRunStatus("tool", "r1", galaxy)).toMatchObject({
      success: true, run: { state: "failed", name: "Tool analysis", history_id: "h1", message: "The input collection could not be expanded." },
    });
  });

  it.each([
    [{ exit_code: 2 }, "A job exited with code 2."],
    [{ job_messages: [{ type: "regex", error_level: 4, desc: "Not enough memory for this input.", match: "private log contents" }] }, "Not enough memory for this input."],
    [{ job_messages: [{ type: "exit_code", error_level: 3, desc: null, code_desc: "Input format is not supported." }] }, "Input format is not supported."],
    [{ job_messages: [{ type: "regex", error_level: 4, desc: null }] }, "A job exceeded its available memory."],
    [{ job_messages: [{ type: "max_discovered_files", error_level: 3, desc: null }] }, "A job produced more output files than Galaxy allows."],
    [{ exit_code: 1, job_messages: [{ type: "regex", error_level: 2, desc: "Unrelated warning" }] }, "A job exited with code 1."],
    [{ exit_code: 1, job_messages: [{ type: "regex", error_level: "3", desc: "Malformed message" }] }, "A job exited with code 1."],
    [{ exit_code: 0, stderr: "private log contents", tool_stderr: "private log contents", job_messages: [{ type: "unsupported", error_level: 3, desc: "private log contents" }] }, "Galaxy reported a failed job or step."],
  ])("uses an existing failed-job description without requesting logs: %j", async (details, expected) => {
    const { galaxy, reads } = context({
      "/api/tool_requests/r1": { id: "r1", state: "submitted", jobs: [{ id: "j1" }] },
      "/api/jobs/j1": { id: "j1", state: "error", tool_id: "fastqc", history_id: "h1", ...details },
      "/api/tools/fastqc?io_details=false": { name: "FastQC" },
    });
    const result = await readRunStatus("tool", "r1", galaxy);
    expect(result).toMatchObject({ success: true, run: { state: "failed", jobs: { failed: 1 } } });
    expect(result.run.message).toContain(expected);
    expect(result.run.message).not.toContain("private log contents");
    expect(reads).toEqual(["/api/tool_requests/r1", "/api/jobs/j1", "/api/tools/fastqc?io_details=false"]);
  });

  it.each([
    ["scheduled", "ok", { running: 2 }, "running"],
    ["scheduled", "new", { ok: 2 }, "queued"],
    ["ready", "ok", { ok: 2 }, "queued"],
    ["scheduled", "ok", { ok: 2 }, "completed"],
    ["completed", "ok", { ok: 2, skipped: 1 }, "completed"],
    ["scheduled", "ok", { error: 1, running: 1 }, "failed"],
    ["scheduled", "failed", {}, "failed"],
    ["scheduled", "ok", {}, "empty"],
    ["scheduled", "ok", { paused: 1 }, "unknown"],
    ["cancelling", "new", { running: 1 }, "running"],
  ] as const)("uses invocation %s, expansion %s and job counts %j to report %s", async (state, populated, counts, expectedState) => {
    const { galaxy, reads } = context({
      "/api/invocations/i1": { id: "i1", state, history_id: "h1", workflow_id: "w1", messages: [] },
      "/api/workflows/w1?instance=true": { name: "Read quality workflow" },
      "/api/invocations/i1/jobs_summary": { id: "i1", model: "WorkflowInvocation", populated_state: populated, states: counts },
    });
    expect(await readRunStatus("workflow", "i1", galaxy)).toMatchObject({
      success: true, run: { kind: "workflow", id: "i1", name: "Read quality workflow", history_id: "h1", state: expectedState },
    });
    expect(reads).toEqual(["/api/invocations/i1", "/api/workflows/w1?instance=true", "/api/invocations/i1/jobs_summary"]);
  });

  it.each(["cancelled", "failed"] as const)("reports an explicit %s invocation without interpreting history-wide jobs", async (state) => {
    const { galaxy, reads } = context({
      "/api/invocations/i1": { id: "i1", state, history_id: "h1", messages: [{ reason: "job_failed", job_id: "internal-job-id" }] },
    });
    const result = await readRunStatus("workflow", "i1", galaxy);
    expect(result).toMatchObject({ success: true, run: { state, history_id: "h1", message: "job failed" } });
    expect(result.run.message).not.toContain("internal-job-id");
    expect(reads).toEqual(["/api/invocations/i1"]);
  });

  it.each([
    new Response("unavailable", { status: 503 }),
    { states: { ok: -1 }, populated_state: "ok" },
    { states: { ok: "2" }, populated_state: "ok" },
    { states: [{ ok: 2 }], populated_state: "ok" },
    { states: true, populated_state: "ok" },
    { states: "broken", populated_state: "ok" },
    { populated_state: "ok" },
  ])("does not claim completion without a valid invocation job summary", async (summary) => {
    const { galaxy } = context({
      "/api/invocations/i1": { id: "i1", state: "scheduled", history_id: "h1", workflow_id: "w1" },
      "/api/workflows/w1?instance=true": { name: "Read quality workflow" },
      "/api/invocations/i1/jobs_summary": summary,
    });
    expect(await readRunStatus("workflow", "i1", galaxy)).toMatchObject({
      success: false, run: { id: "i1", name: "Read quality workflow", history_id: "h1", state: "unknown" },
    });
  });

  it("keeps an incomplete invocation response unknown", async () => {
    const { galaxy } = context({ "/api/invocations/i1": {} });
    expect(await readRunStatus("workflow", "i1", galaxy)).toMatchObject({ success: false, run: { id: "i1", state: "unknown" } });
  });
});
