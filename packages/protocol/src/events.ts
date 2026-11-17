import { z } from "zod";

export const RUN_OUTCOME_EVENT = "galaxy.run.outcome";
export const eventArguments = z.object({
  instance: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe("An authorized Galaxy routing alias from get_galaxy_connections. Handles belong to this site."),
  kind: z.enum(["tool", "workflow"]),
  runId: z.string().trim().min(1).max(512).describe("An already submitted tool-request or workflow-invocation handle, not a job or history id."),
}).strict();

export function webhookKey(secret: string): Buffer {
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (!secret.startsWith("whsec_") || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || key.length < 24 || key.length > 64 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new Error("Invalid webhook signing secret.");
  }
  return key;
}
export const callbackUrl = z.string().max(4096).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; }
  catch { return false; }
}, "Callback must use HTTPS without credentials or a fragment.").transform(value => new URL(value).href);
const signingSecret = z.string().max(100).refine(value => { try { webhookKey(value); return true; } catch { return false; } }, "Invalid webhook signing secret.");
export const subscribeParams = z.object({
  name: z.literal(RUN_OUTCOME_EVENT), arguments: eventArguments,
  delivery: z.object({ mode: z.literal("webhook"), url: callbackUrl, secret: signingSecret }).strict(),
  cursor: z.null().optional(), ttlMs: z.number().int().positive().nullable().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const unsubscribeParams = subscribeParams.pick({ name: true, arguments: true, _meta: true }).extend({
  delivery: z.object({ mode: z.literal("webhook"), url: callbackUrl }).strict(),
});
export const outcomeData = z.object({
  galaxy: z.object({ instance: z.string().max(64), url: z.string().url().max(4096) }).strict(),
  kind: z.enum(["tool", "workflow"]), run_id: z.string().min(1).max(512), name: z.string().max(512),
  state: z.enum(["completed", "failed", "cancelled", "empty"]), checked_at: z.string().datetime(),
  history_id: z.string().min(1).max(512).optional(), history_url: z.string().url().max(4096).optional(),
  execution_only: z.literal(true).describe("Execution status only; no scientific-result validation. A detected failure may coexist with running jobs."),
}).strict();
export const outcomeEvent = z.object({
  eventId: z.string().uuid(), name: z.literal(RUN_OUTCOME_EVENT), timestamp: z.string().datetime(),
  data: outcomeData, cursor: z.null(),
}).strict();
export const eventState = z.object({
  phase: z.enum(["watching", "pending", "delivered", "stopped"]), attempts: z.number().int().min(0).max(20),
  pending: outcomeEvent.optional(),
}).strict();
export const storedSubscription = z.object({
  id: z.string(), arguments: eventArguments, delivery: subscribeParams.shape.delivery,
  expiresAt: z.number().int().positive(), verifiedAt: z.number().int(), state: eventState,
  previousSecret: signingSecret.optional(), previousSecretUntil: z.number().int().optional(),
}).strict();
export const eventLease = z.object({
  subscription: storedSubscription, revision: z.number().int().positive(), lease: z.string(),
  // apiKey holds a sign-in's access token when tokenType is bearer.
  connection: z.object({ instance: z.string(), baseUrl: z.string().url(), apiKey: z.string().min(1), tokenType: z.literal("bearer").optional() }).strict(),
}).strict();
export const subscriptionResult = z.object({ id: z.string(), refreshBefore: z.string().datetime(), cursor: z.null(), truncated: z.literal(false) }).strict();
export type EventSubscription = z.infer<typeof storedSubscription>;
export type EventLease = z.infer<typeof eventLease>;
export type EventState = z.infer<typeof eventState>;
export type SubscribeParams = z.infer<typeof subscribeParams>;
export type UnsubscribeParams = z.infer<typeof unsubscribeParams>;
export type EventAction = "prepare" | "subscribe" | "unsubscribe" | "claim" | "check" | "save";
export type EventRequest = (action: EventAction, body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
