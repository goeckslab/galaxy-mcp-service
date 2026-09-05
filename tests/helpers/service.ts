import type { AddressInfo } from "node:net";
import { once } from "node:events";

import { createApp, type AppOptions } from "../../apps/service/src/app.js";

export const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "probe-test", version: "0.1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

export function modernRequest(method: string, params: Record<string, unknown> = {}, id: string | number = 1) {
  const body = { jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta } };
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  });
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  return { body, headers };
}

export async function startTestService(options: Pick<AppOptions, "auth" | "galaxy" | "publicBaseUrl"> = {}) {
  const logs: string[] = [];
  const service = createApp({ ...options, host: "127.0.0.1", log: (line) => logs.push(line) });
  const server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    logs,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      await service.close();
    },
  };
}

export async function postModern(
  baseUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  id: string | number = 1,
): Promise<Response> {
  const request = modernRequest(method, params, id);
  return fetch(`${baseUrl}/mcp`, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
}
