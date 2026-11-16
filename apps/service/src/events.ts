import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

import { ProtocolError, type AuthInfo, type BaseContext, type McpServer } from "@modelcontextprotocol/server";
import { eventArguments, eventLease, outcomeData, outcomeEvent, RUN_OUTCOME_EVENT, subscribeParams, subscriptionResult,
  unsubscribeParams, webhookKey, type EventLease, type EventRequest, type EventState, type EventSubscription } from "@galaxy-mcp-service/protocol";
import { z } from "zod";

import { connectionSource, createRequestGalaxyContext, type GalaxyConnection } from "./galaxy-connection.js";
import { readRunStatus } from "./run-status.js";

const blockedV4 = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) {
  blockedV4.addSubnet(address, prefix, "ipv4");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blockedV6.addSubnet(address, prefix, "ipv6");
export function isPublicWebhookAddress(address: string): boolean {
  return isIP(address) === 4 ? !blockedV4.check(address, "ipv4")
    : isIP(address) === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

const callbackError = (reason: string) => new ProtocolError(-32015, "CallbackEndpointError", { reason });
type WebhookTarget = Pick<EventSubscription, "id" | "delivery" | "previousSecret" | "previousSecretUntil">;
export function webhookHeaders(target: WebhookTarget, id: string, body: string, signedAt = Math.floor(Date.now() / 1000)) {
  const secrets = [target.delivery.secret];
  if (target.previousSecret && (target.previousSecretUntil ?? 0) > Date.now()) secrets.push(target.previousSecret);
  return { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(signedAt),
    "webhook-signature": [...new Set(secrets)].map(secret => "v1," + createHmac("sha256", webhookKey(secret)).update(`${id}.${signedAt}.${body}`).digest("base64")).join(" "),
    "x-mcp-subscription-id": target.id };
}

/** HTTPS only, no redirects/proxy, all DNS answers checked and the chosen address pinned for this connection. */
export async function sendWebhook(target: WebhookTarget, id: string, payload: unknown, signal: AbortSignal): Promise<{ status: number; text: string }> {
  const url = new URL(target.delivery.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw callbackError("invalid_url");
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 262144) throw callbackError("payload_too_large");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let abortLookup: () => void = () => {};
  try {
    deadline.throwIfAborted();
    const addresses = await Promise.race([
      isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => { abortLookup = () => reject(callbackError("timeout")); deadline.addEventListener("abort", abortLookup, { once: true }); }),
    ]);
    if (!addresses.length || addresses.some(value => !isPublicWebhookAddress(value.address))) throw callbackError("private_address");
    const address = addresses[0]!;
    deadline.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const request = httpsRequest(url, {
        method: "POST", agent: false, signal: deadline, family: address.family, rejectUnauthorized: true,
        lookup: (_host, _options, done) => done(null, address.address, address.family),
        headers: { ...webhookHeaders(target, id, body), "content-length": Buffer.byteLength(body) },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) request.destroy(new Error("Callback response too large."));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end(body);
    });
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw callbackError(deadline.aborted ? "timeout" : "transport_failed");
  } finally { deadline.removeEventListener("abort", abortLookup); }
}

function modernOnly(ctx: BaseContext) {
  if ((ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") {
    throw new ProtocolError(-32600, "MCP Events requires protocol 2026-07-28.");
  }
}
export function registerRunEvents(server: McpServer, auth: AuthInfo, connections: GalaxyConnection[], backend: EventRequest) {
  // The SDK's public types predate Events; custom handlers use its supported extension seam.
  server.server.registerCapabilities({ ...server.server.getCapabilities(), ...{ events: {} } });
  server.server.setRequestHandler("events/list", {
    params: z.object({ cursor: z.null().optional(), _meta: z.record(z.string(), z.unknown()).optional() }).strict(),
    result: z.object({ events: z.array(z.unknown()) }),
  }, (_params, ctx) => {
    modernOnly(ctx);
    return { events: [{ name: RUN_OUTCOME_EVENT,
      description: "Opt in to one outcome notification for a specific already-submitted Galaxy analysis: completed, a detected failure, cancelled, or no jobs ran. Never monitors future analyses or submits a run. Completion concerns execution only, not scientific validity. Failures may be detected while other jobs still run. Revoke access or unsubscribe to stop notifications.",
      delivery: ["webhook"], inputSchema: z.toJSONSchema(eventArguments), payloadSchema: z.toJSONSchema(outcomeData),
    }] };
  });
  server.server.setRequestHandler("events/subscribe", { params: subscribeParams, result: subscriptionResult }, async (params, ctx) => {
    modernOnly(ctx);
    const connection = connections.find(value => connectionSource(value).instance === params.arguments.instance);
    if (!connection) throw new ProtocolError(-32602, "The Galaxy site is not authorized.");
    const status = await readRunStatus(params.arguments.kind, params.arguments.runId,
      createRequestGalaxyContext(connection, AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(30000)])));
    if (!status.success) throw new ProtocolError(-32602, "The existing analysis could not be verified. No analysis or subscription was created.");
    const request = { ...params }; delete request._meta;
    const prepared = z.object({ id: z.string(), verification_required: z.boolean(), verified_at: z.number().int().nullable() }).strict()
      .parse(await backend("prepare", { token: auth.token, params: request }, ctx.mcpReq.signal));
    let verifiedAt = prepared.verified_at;
    if (prepared.verification_required) {
      const challenge = randomBytes(32).toString("base64url");
      const reply = await sendWebhook({ id: prepared.id, delivery: params.delivery }, `verification_${randomUUID()}`, { type: "verification", challenge }, ctx.mcpReq.signal);
      let payload: unknown;
      try { payload = JSON.parse(reply.text); } catch { throw callbackError("challenge_failed"); }
      const echo = z.object({ challenge: z.string().max(100) }).passthrough().safeParse(payload);
      const actual = Buffer.from(echo.data?.challenge ?? "");
      const expected = Buffer.from(challenge);
      if (reply.status < 200 || reply.status >= 300 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw callbackError("challenge_failed");
      verifiedAt = Date.now();
    }
    return subscriptionResult.parse(await backend("subscribe", { token: auth.token, params: request, verified_at: verifiedAt }, ctx.mcpReq.signal));
  });
  server.server.setRequestHandler("events/unsubscribe", { params: unsubscribeParams, result: z.object({}).strict() }, async (params, ctx) => {
    modernOnly(ctx);
    const request = { ...params }; delete request._meta;
    await backend("unsubscribe", { token: auth.token, params: request }, ctx.mcpReq.signal);
    return {};
  });
}

/** One tick can also be run directly in a test or by an external scheduler; database leases serialize workers. */
export async function processRunEvent(backend: EventRequest, signal: AbortSignal, deliver = sendWebhook): Promise<boolean> {
  const claimed = z.object({ item: eventLease.nullable() }).strict().parse(await backend("claim", {}, signal)).item;
  if (!claimed) return false;
  let item: EventLease = claimed;
  let state = item.subscription.state;
  const save = async (next: EventState, delayMs: number, release = true) => {
    const response = z.object({ saved: z.object({ revision: z.number().int().positive() }).nullable() }).strict().parse(await backend("save", {
      id: item.subscription.id, revision: item.revision, lease: item.lease, state: next, delay_ms: delayMs, release,
    }, signal));
    if (response.saved) { item = { ...item, revision: response.saved.revision }; state = next; }
    return response.saved !== null;
  };
  try {
    if (["delivered", "stopped"].includes(state.phase)) { await save(state, 0); return true; }
    // Check Galaxy access on retries as well as the broker grant; never send a cached outcome after key revocation.
    const result = await readRunStatus(item.subscription.arguments.kind, item.subscription.arguments.runId,
      createRequestGalaxyContext(item.connection, AbortSignal.any([signal, AbortSignal.timeout(30000)])));
    if (!result.success) throw new Error("Run status is unconfirmed.");
    if (state.phase === "watching") {
      if (!["completed", "failed", "cancelled", "empty"].includes(result.run.state)) { await save({ phase: "watching", attempts: 0 }, 60000); return true; }
      const run = result.run;
      const event = outcomeEvent.parse({ eventId: randomUUID(), name: RUN_OUTCOME_EVENT, timestamp: run.checked_at, cursor: null,
        data: { galaxy: connectionSource(item.connection), kind: run.kind, run_id: run.id, name: run.name.slice(0, 512),
          state: run.state, checked_at: run.checked_at, execution_only: true,
          ...(run.history_id && { history_id: run.history_id,
            history_url: `${item.connection.baseUrl.replace(/\/$/, "")}/histories/view?id=${encodeURIComponent(run.history_id)}` }),
        },
      });
      // Persist the exact event before delivery; an interrupted/failed delivery retries the same ID and body.
      if (!await save({ phase: "pending", attempts: 0, pending: event }, 0, false)) return true;
    }
    const current = z.object({ item: eventLease.nullable() }).strict().parse(await backend("check", {
      id: item.subscription.id, revision: item.revision, lease: item.lease,
    }, signal)).item;
    if (!current) return true;
    item = current;
    state = item.subscription.state;
    if (!state.pending) throw new Error("Missing persisted outcome.");
    const response = await deliver(item.subscription, state.pending.eventId, state.pending, signal);
    if (response.status >= 200 && response.status < 300) await save({ ...state, phase: "delivered" }, 0);
    else if ([410, 413].includes(response.status)) await save({ ...state, phase: "stopped" }, 0);
    else throw new Error("Callback did not acknowledge the outcome.");
  } catch {
    if (signal.aborted) return true; // Lease expires; the next worker resumes the persisted event.
    const attempts = Math.min(20, state.attempts + 1);
    await save({ ...state, attempts, ...(state.phase === "pending" && attempts >= 5 && { phase: "stopped" }) }, Math.min(300000, 15000 * 2 ** Math.min(attempts, 5)));
  }
  return true;
}

export function startRunEvents(backend: EventRequest, onerror: () => void) {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running || controller.signal.aborted) return;
    // ponytail: five leases per 15 s tick; increase the batch only if measured notification latency needs it.
    running = (async () => { for (let i = 0; i < 5 && !controller.signal.aborted; i++) if (!await processRunEvent(backend, controller.signal)) break; })()
      .catch(() => { if (!controller.signal.aborted) onerror(); }).finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); controller.abort(); await running; };
}
