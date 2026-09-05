import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRequestGalaxyContext } from "../../apps/service/src/galaxy-connection.js";

afterEach(() => vi.restoreAllMocks());

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("request-scoped Galaxy connection", () => {
  it.each(["MCP", "HTTP request", "deadline"])("cancels an in-flight fetch on %s cancellation", async (source) => {
    const mcp = new AbortController();
    const http = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let dispatched!: () => void;
    const entered = new Promise<void>((resolve) => { dispatched = resolve; });
    const fetchImpl: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("error");
      expect(request.headers.get("x-api-key")).toBe("fixture-key");
      dispatched();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    };
    const galaxy = createRequestGalaxyContext(
      { baseUrl: "https://galaxy.example.test", apiKey: "fixture-key", fetchImpl },
      mcp.signal,
    );
    const pending = galaxy.client.GET("/api/histories", { signal: http.signal, redirect: "follow" });
    await entered;
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(galaxy.poll.timeoutMs).toBeGreaterThan(60_000);
    const controller = source === "MCP" ? mcp : source === "HTTP request" ? http : deadline;
    const reason = new DOMException(source, source === "deadline" ? "TimeoutError" : "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("starts a fresh HTTP deadline on each poll and refuses already-cancelled dispatch", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([]));
    const controller = new AbortController();
    const galaxy = createRequestGalaxyContext(
      { baseUrl: "https://galaxy.example.test", apiKey: "fixture-key", fetchImpl },
      controller.signal,
    );
    await galaxy.client.GET("/api/histories");
    await galaxy.client.GET("/api/histories");
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout.mock.results[0]?.value).not.toBe(timeout.mock.results[1]?.value);
    controller.abort();
    await expect(galaxy.client.GET("/api/histories")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never forwards the API key to a cross-origin redirect destination", async () => {
    let destinationRequests = 0;
    const destination = createServer((_req, res) => {
      destinationRequests += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    const destinationUrl = await listen(destination);
    let receivedApiKey: string | string[] | undefined;
    const redirect = createServer((req, res) => {
      receivedApiKey = req.headers["x-api-key"];
      res.writeHead(302, { location: destinationUrl }).end();
    });
    const baseUrl = await listen(redirect);
    try {
      const galaxy = createRequestGalaxyContext({ baseUrl, apiKey: "fixture-key" }, new AbortController().signal);
      await expect(galaxy.client.GET("/api/histories", { redirect: "follow" })).rejects.toThrow();
      expect(receivedApiKey).toBe("fixture-key");
      expect(destinationRequests).toBe(0);
    } finally {
      await Promise.all([close(redirect), close(destination)]);
    }
  });
});
