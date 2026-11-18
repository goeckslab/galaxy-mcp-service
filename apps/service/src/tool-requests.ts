import {
  classifyHttp,
  GalaxyError,
  isJobSuccess,
  isJobTerminal,
  type AnyOperation,
  type GalaxyContext,
  type ImplicitCollectionRef,
  type JobDetail,
  type Operation,
} from "@galaxyproject/galaxy-ops";
import { z } from "zod";

/**
 * Tool runs through Galaxy's tool request API (POST /api/jobs, strict), answered as soon as Galaxy
 * accepts the request, plus the read of a request's progress and a template in the nested shape
 * that API takes. galaxy-ops' own run_tool posts to the legacy /api/tools (still so in 0.5), and
 * its tool request path waits for the jobs to finish, so these live here, in place of the patch
 * this service used to apply to galaxy-ops, until galaxy-ops offers them.
 */

/** A request Galaxy accepted and will expand into jobs; resume it rather than submitting again. */
export interface ToolRequestRecovery {
  toolRequestId: string;
  toolId?: string;
  historyId?: string;
  jobIds: string[];
}

export interface ToolSubmission {
  toolRequestId: string;
  toolId: string;
  historyId: string;
  state: "accepted";
}

export interface ToolRequestStatus {
  toolRequestId: string;
  requestState: string;
  state: "pending" | "ok" | "error" | "empty";
  stateMessage?: unknown;
  jobs: JobDetail[];
  implicitCollections: ImplicitCollectionRef[];
}

interface ToolRequestDetail {
  state?: unknown;
  state_message?: unknown;
  jobs?: { id: string }[];
  implicit_collections?: ImplicitCollectionRef[];
  request?: { tool_id?: unknown; history_id?: unknown };
}

/** A failure that still names the request, so a caller resumes it instead of submitting again. */
function tracked(error: unknown, recovery: ToolRequestRecovery): GalaxyError & { recovery: ToolRequestRecovery } {
  const result = (error instanceof GalaxyError ? error
    : new GalaxyError(error instanceof Error ? error.message : String(error), { cause: error })) as GalaxyError & { recovery: ToolRequestRecovery };
  result.recovery = recovery;
  return result;
}

const runInput = {
  toolId: z.string().describe("Tool id, e.g. 'fastqc/0.74'"),
  historyId: z.string().describe("Encoded history id to run in"),
  inputs: z.record(z.string(), z.unknown()).describe("Nested tool inputs: data refs as {src:'hda',id}, batches as {__class__:'Batch',values:[...]}"),
  toolVersion: z.string().optional().describe("Optional explicit tool version"),
};

async function submitToolRequest(args: z.infer<z.ZodObject<typeof runInput>>, ctx: GalaxyContext): Promise<ToolSubmission> {
  const submit = await ctx.client.POST("/api/jobs", {
    body: {
      tool_id: args.toolId,
      ...(args.toolVersion !== undefined && { tool_version: args.toolVersion }),
      history_id: args.historyId,
      inputs: args.inputs,
      strict: true,
      send_email_notification: false,
    },
  });
  if (submit.error || !submit.data) throw classifyHttp(submit.response.status, submit.error);
  const toolRequestId: unknown = submit.data.tool_request_id;
  if (typeof toolRequestId !== "string" || !toolRequestId.trim()) {
    throw new GalaxyError(
      `Galaxy returned no tool request id for tool ${args.toolId} in history ${args.historyId}; submission outcome unknown; do not resubmit automatically.`,
    );
  }
  return { toolRequestId, toolId: args.toolId, historyId: args.historyId, state: "accepted" };
}

export const submitToolOp: Operation<typeof runInput, ToolSubmission> = {
  name: "run_tool",
  domain: "tools",
  summary: "Submit nested tool inputs and return an accepted request handle immediately. Check get_tool_request_status for progress; do not submit again while that request is pending.",
  input: runInput,
  readOnly: false,
  run: submitToolRequest,
  project: (o) => ({ message: `Tool request ${o.toolRequestId} accepted; execution is not yet complete.` }),
};

/** One read of a request and its jobs; never submits or waits. */
export async function getToolRequestStatus({ toolRequestId: id }: { toolRequestId: string }, ctx: GalaxyContext): Promise<ToolRequestStatus> {
  const recovery: ToolRequestRecovery = { toolRequestId: id, jobIds: [] };
  try {
    const { data, error, response } = await ctx.client.GET("/api/tool_requests/{id}", { params: { path: { id } } });
    if (error || !data) throw classifyHttp(response.status, error);
    const detail = data as ToolRequestDetail;
    const refs = detail.jobs ?? [];
    recovery.jobIds = refs.map((ref) => ref.id);
    if (typeof detail.request?.tool_id === "string") recovery.toolId = detail.request.tool_id;
    if (typeof detail.request?.history_id === "string") recovery.historyId = detail.request.history_id;
    const jobs: JobDetail[] = [];
    for (const ref of refs) {
      const job = await ctx.client.GET("/api/jobs/{job_id}", { params: { path: { job_id: ref.id } } });
      if (job.error || !job.data) throw classifyHttp(job.response.status, job.error);
      jobs.push(job.data as JobDetail);
    }
    const requestState = String(detail.state);
    const failed = requestState === "failed" || jobs.some((job) => isJobTerminal(job.state ?? "") && !isJobSuccess(job.state ?? ""));
    const complete = requestState === "submitted" && jobs.length > 0 && jobs.every((job) => isJobSuccess(job.state ?? ""));
    const empty = requestState === "submitted" && jobs.length === 0;
    return {
      toolRequestId: id,
      requestState,
      state: failed ? "error" : empty ? "empty" : complete ? "ok" : "pending",
      stateMessage: detail.state_message,
      jobs,
      implicitCollections: detail.implicit_collections ?? [],
    };
  } catch (error) {
    throw tracked(error, recovery);
  }
}

const statusInput = { toolRequestId: z.string().describe("Previously accepted tool request id") };

export const getToolRequestStatusOp: Operation<typeof statusInput, ToolRequestStatus> = {
  name: "get_tool_request_status",
  domain: "jobs",
  summary: "Read an accepted tool request and its jobs once, without resubmitting or waiting. Only state 'ok' means all spawned jobs completed successfully. State 'empty' is terminal: no jobs were created and no analysis ran.",
  input: statusInput,
  run: getToolRequestStatus,
  project: (o) => ({ message: o.state === "empty" ? `Tool request ${o.toolRequestId}: no jobs were created; no analysis ran.` : `Tool request ${o.toolRequestId}: ${o.state} (${o.jobs.length} job(s))` }),
};

// The template in the tool request API's nested shape: a section is an object, a conditional an
// object holding its test parameter, a repeat an array, with each parameter's declared default.
type Param = Record<string, unknown>;
const MAX_OPTIONS = 25;
const params = (value: unknown): Param[] => (Array.isArray(value) ? value : []).filter((p): p is Param => p != null && typeof p === "object");

function optionValues(p: Param): unknown[] {
  return (Array.isArray(p.options) ? p.options : []).slice(0, MAX_OPTIONS).map((o) => Array.isArray(o) && o.length > 1 ? o[1] : o);
}

const optionsTruncated = (p: Param) => Array.isArray(p.options) && p.options.length > MAX_OPTIONS;

function numericValue(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function placeholder(p: Param): unknown {
  const ptype = p.type;
  if (ptype === "data") {
    const ref = { src: "hda", id: "<dataset_id>" };
    return p.multiple === true ? [ref] : ref;
  }
  if (ptype === "data_collection") return { src: "hdca", id: "<collection_id>" };
  const value = p.value ?? p.default;
  if (p.optional === true && p.value === null) return null;
  if (ptype === "integer" || ptype === "float") {
    const min = numericValue(p.min) ?? -Infinity;
    const max = numericValue(p.max) ?? Infinity;
    const declared = numericValue(value);
    const valid = (n: number) => n >= min && n <= max && (ptype !== "integer" || Number.isInteger(n));
    if (declared !== undefined && valid(declared)) return declared;
    const fallback = Math.max(min, Math.min(max, 0));
    return Number.isFinite(fallback) && valid(fallback) ? fallback : "<value>";
  }
  if (value !== undefined) return value;
  if (ptype === "select") {
    const selected = (Array.isArray(p.options) ? p.options : []).filter((o) => Array.isArray(o) && o[2] === true).map((o) => (o as unknown[])[1]);
    if (p.multiple === true) return selected;
    if (selected.length) return selected[0];
    const choices = optionValues(p);
    return choices.length > 0 ? choices[0] : "<choice>";
  }
  if (ptype === "boolean") return false;
  return "<value>";
}

function fillParam(p: Param): unknown {
  const ptype = p.type;
  if (ptype === "repeat") {
    const count = Math.min(numericValue(p.max) ?? Infinity, Math.max(numericValue(p.min) ?? 0, numericValue(p.default) ?? 1));
    return Array.from({ length: count }, () => buildInputTemplate(params(p.inputs)));
  }
  if (ptype === "section") return buildInputTemplate(params(p.inputs));
  if (ptype === "conditional") {
    const tp = (p.test_param ?? {}) as Param;
    const tpName = tp.name;
    const cases = params(p.cases);
    const selected = placeholder(tp);
    const trueValue = tp.truevalue ?? "true";
    const falseValue = tp.falsevalue ?? "false";
    const caseValue = tp.type === "boolean" ? (selected === true ? trueValue : falseValue) : selected;
    const active = cases.find((c) => String(c.value) === String(caseValue)) ?? cases[0];
    let selector = active?.value ?? selected;
    if (tp.type === "boolean") selector = active ? String(active.value) === String(trueValue) : selected;
    return { ...buildInputTemplate(params(active?.inputs)), ...(typeof tpName === "string" && tpName ? { [tpName]: selector } : {}) };
  }
  return placeholder(p);
}

function buildInputTemplate(inputs: Param[]): Record<string, unknown> {
  return Object.fromEntries(inputs.filter((p) => typeof p.name === "string").map((p) => [p.name as string, fillParam(p)]));
}

function summarizeParam(p: Param): Param {
  const ptype = p.type ?? p.model_class;
  const out: Param = { name: p.name, type: ptype };
  if (p.optional != null) out.optional = p.optional;
  for (const key of ["label", "value", "default", "min", "max", "multiple", "truevalue", "falsevalue"]) {
    if (p[key] !== undefined) out[key] = p[key];
  }
  if (ptype === "repeat") {
    out.repeat_key_hint = `${String(p.name)}[0].<param>`;
    out.children = params(p.inputs).map(summarizeParam);
  } else if (ptype === "section") {
    out.section_key_hint = `${String(p.name)}.<param>`;
    out.children = params(p.inputs).map(summarizeParam);
  } else if (ptype === "conditional") {
    const tp = (p.test_param ?? {}) as Param;
    const selector: Param = { ...summarizeParam(tp), choices: optionValues(tp), key_hint: `${String(p.name)}.${String(tp.name)}` };
    if (optionsTruncated(tp)) selector.choices_truncated = true;
    out.selector = selector;
    out.cases = params(p.cases).map((c) => ({ when: c.value, params: params(c.inputs).map(summarizeParam) }));
  } else if (ptype === "select") {
    out.choices = optionValues(p);
    if (optionsTruncated(p)) out.choices_truncated = true;
  }
  return out;
}

const templateInput = { toolId: z.string().describe("tool id") };

export const getToolInputTemplateOp: Operation<typeof templateInput, { tool_id: string; inputs_template: Record<string, unknown>; parameters: Param[] }> = {
  name: "get_tool_input_template",
  domain: "tools",
  summary: "Return a ready-to-fill inputs skeleton for a Galaxy tool, plus a compact parameter summary. Call before run_tool when unsure how to shape inputs.",
  input: templateInput,
  async run(i, ctx) {
    // The tool record is not in Galaxy's OpenAPI description, so read it untyped.
    const get = ctx.client.GET as unknown as (path: string, init: unknown) => Promise<{ data?: Param; error?: unknown; response: Response }>;
    const { data, error, response } = await get("/api/tools/{tool_id}", { params: { path: { tool_id: i.toolId }, query: { io_details: true, link_details: false } } });
    if (error || data == null) throw classifyHttp(response.status, error);
    const inputs = params(data.inputs);
    return { tool_id: i.toolId, inputs_template: buildInputTemplate(inputs), parameters: inputs.map(summarizeParam) };
  },
  project: (out, i) => ({ message: `Input template for ${i.toolId} (${out.parameters.length} top-level param(s))` }),
};

/** The operations above, standing in for galaxy-ops' own run_tool and get_tool_input_template. */
export const toolRequestOperations: AnyOperation[] = [submitToolOp, getToolRequestStatusOp, getToolInputTemplateOp] as unknown as AnyOperation[];
