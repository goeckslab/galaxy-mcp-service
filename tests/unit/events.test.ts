import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

import { eventState, webhookKey, type EventLease, type EventRequest } from "../../packages/protocol/src/events.js";
import { isPublicWebhookAddress, processRunEvent, sendWebhook, webhookHeaders } from "../../apps/service/src/events.js";
import { createGalaxyMcpHandler } from "../../apps/service/src/mcp.js";
import { modernRequest } from "../helpers/service.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const secret = "whsec_" + Buffer.alloc(32, 42).toString("base64");
const target = { id: "sub_fixture", delivery: { mode: "webhook" as const, url: "https://callback.example.test/events", secret } };
const galaxyFetch: typeof fetch = async input => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const data = url.pathname.endsWith("/jobs_summary") ? { states: { ok: 1 }, populated_state: "ok" }
    : { id: "run-1", state: "scheduled", history_id: "history-1" };
  return Response.json(data);
};

describe("opt-in run events", () => {
  it("signs exact bytes, pins only public DNS results, rejects private destinations and never follows redirects", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.100.100.200", "192.168.1.1", "0.0.0.0", "224.0.0.1", "198.18.1.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "2001:db8::1", "2002:7f00:1::"]) expect(isPublicWebhookAddress(address)).toBe(false);
    expect(isPublicWebhookAddress("8.8.8.8")).toBe(true);
    expect(isPublicWebhookAddress("2606:4700:4700::1111")).toBe(true);
    for (const bad of ["whsec_a", "whsec_" + Buffer.alloc(32).toString("base64") + "junk", "not-a-secret"]) expect(() => webhookKey(bad)).toThrow();
    const body = '{"text":"α"}';
    const headers = webhookHeaders(target, "event-1", body, 1000);
    expect(headers["webhook-signature"]).toBe("v1," + createHmac("sha256", Buffer.alloc(32, 42)).update("event-1.1000." + body).digest("base64"));
    expect(webhookHeaders({ ...target, previousSecret: "whsec_" + Buffer.alloc(32, 7).toString("base64"), previousSecretUntil: Date.now() + 60000 }, "event-1", body)["webhook-signature"].split(" ")).toHaveLength(2);
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] as never);
    await expect(sendWebhook(target, "event-1", {}, new AbortController().signal)).rejects.toMatchObject({ code: -32015, data: { reason: "private_address" } });
    expect(request).not.toHaveBeenCalled();
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    vi.mocked(request).mockImplementation(((_url: unknown, options: Record<string, unknown>, onResponse: (response: EventEmitter) => void) => {
      const pinned = vi.fn();
      (options.lookup as (...args: unknown[]) => void)("callback.example.test", {}, pinned);
      expect(pinned).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      const req = new EventEmitter() as EventEmitter & { end: (body: string) => void };
      req.end = sent => {
        const response = Object.assign(new EventEmitter(), { statusCode: 302 });
        onResponse(response);
        expect(options.headers).toMatchObject(webhookHeaders(target, "event-1", sent));
        response.emit("end");
      };
      return req;
    }) as never);
    expect(await sendWebhook(target, "event-1", { text: "α" }, new AbortController().signal)).toEqual({ status: 302, text: "" });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(sendWebhook(target, "event-1", "x".repeat(262144), new AbortController().signal)).rejects.toMatchObject({ code: -32015 });
  });

  it("discovers Events over MCP 2, verifies callbacks before activation, and refuses unauthorized sites", async () => {
    const calls: string[] = [];
    const backend: EventRequest = async action => {
      calls.push(action);
      return action === "prepare" ? { id: target.id, verification_required: true, verified_at: null }
        : action === "subscribe" ? { id: target.id, refreshBefore: new Date(Date.now() + 60000).toISOString(), cursor: null, truncated: false } : {};
    };
    const authInfo = { token: "fixture-bearer", clientId: "fixture-client", scopes: ["galaxy:full"], extra: { galaxies: [{ instance: "us", baseUrl: "https://usegalaxy.org", apiKey: "fixture-key", fetchImpl: galaxyFetch }] } };
    const handler = createGalaxyMcpHandler(error => { throw error; }, undefined, undefined, undefined, backend);
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const { body, headers } = modernRequest(method, params);
      return (await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }), { authInfo })).json();
    };
    try {
      expect(await call("server/discover")).toHaveProperty("result.capabilities.events");
      expect(await call("events/list")).toMatchObject({ result: { events: [{ name: "galaxy.run.outcome", delivery: ["webhook"] }] } });
      const params = { name: "galaxy.run.outcome", arguments: { instance: "us", kind: "workflow", runId: "run-1" }, delivery: target.delivery };
      expect(await call("events/subscribe", { ...params, arguments: { ...params.arguments, instance: "eu" } })).toHaveProperty("error.code", -32602);
      expect(calls).toHaveLength(0);
      vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
      let challengeReply = true;
      vi.mocked(request).mockImplementation(((_url: unknown, _options: unknown, respond: (response: EventEmitter) => void) => {
        const req = new EventEmitter() as EventEmitter & { end: (body: string) => void };
        req.end = body => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200 });
          respond(response);
          const { challenge, type } = JSON.parse(body);
          expect(type).toBe("verification");
          response.emit("data", Buffer.from(JSON.stringify({ challenge: challengeReply ? challenge : "wrong" })));
          response.emit("end");
        }; return req;
      }) as never);
      expect(await call("events/subscribe", params)).toHaveProperty("result.id", target.id);
      expect(calls).toEqual(["prepare", "subscribe"]);
      expect(await call("events/unsubscribe", { ...params, delivery: { mode: "webhook", url: target.delivery.url } })).toHaveProperty("result.resultType", "complete");
      challengeReply = false;
      expect(await call("events/subscribe", params)).toMatchObject({ error: { code: -32015, data: { reason: "challenge_failed" } } });
      expect(calls.filter(action => action === "subscribe")).toHaveLength(1);
    } finally { await handler.close(); }
  });

  it("persists an outcome before delivery, preserves its ID on retry, and stops on 410 or revocation", async () => {
    let item: EventLease = { subscription: { ...target, arguments: { instance: "us", kind: "workflow", runId: "run-1" }, expiresAt: Date.now() + 60000, verifiedAt: Date.now(), state: { phase: "watching", attempts: 0 } },
      revision: 1, lease: "fixture-lease", connection: { instance: "us", baseUrl: "https://usegalaxy.org", apiKey: "fixture-key" } };
    let active = true;
    const backend: EventRequest = async (action, input) => {
      if (action === "claim" || action === "check") return { item: active ? structuredClone(item) : null };
      if (action === "save") { item = { ...item, subscription: { ...item.subscription, state: eventState.parse(input.state) }, revision: item.revision + 1 }; return { saved: { revision: item.revision } }; }
      throw new Error("Unexpected event action.");
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(galaxyFetch);
    const delivered: string[] = [];
    try {
      const deliver = vi.fn(async (_target: unknown, id: string) => {
        expect(item.subscription.state.phase).toBe("pending");
        delivered.push(id);
        return { status: delivered.length === 1 ? 503 : 200, text: "" };
      });
      await processRunEvent(backend, new AbortController().signal, deliver);
      expect(item.subscription.state).toMatchObject({ phase: "pending", attempts: 1, pending: { data: { state: "completed", execution_only: true } } });
      await processRunEvent(backend, new AbortController().signal, deliver);
      expect(item.subscription.state.phase).toBe("delivered");
      expect(delivered[1]).toBe(delivered[0]);
      item.subscription.state = { ...item.subscription.state, phase: "pending" };
      await processRunEvent(backend, new AbortController().signal, async () => ({ status: 410, text: "" }));
      expect(item.subscription.state.phase).toBe("stopped");
      active = false;
      expect(await processRunEvent(backend, new AbortController().signal, deliver)).toBe(false);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    } finally { fetchSpy.mockRestore(); }
  });
});
