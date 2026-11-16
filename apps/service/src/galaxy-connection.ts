import { createGalaxyContext } from "@galaxyproject/galaxy-ops";
import type { AuthInfo, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface GalaxyConnection {
  instance?: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export const instanceInput = {
  instance: z.string().min(1).max(256).optional().describe("Authorized instance alias from get_galaxy_connections. Required when more than one site is connected; keep it with every history, dataset and run handle."),
};
export const galaxySource = z.object({ instance: z.string(), url: z.string().url() });
export const sourceOutput = { galaxy: galaxySource.optional() };
export const connectionSource = (connection: GalaxyConnection) => ({
  instance: connection.instance ?? new URL(connection.baseUrl).host, url: connection.baseUrl,
});

export function authenticatedGalaxies(authInfo: AuthInfo): GalaxyConnection[] {
  const values = authInfo.extra?.galaxies;
  if (!Array.isArray(values) || !values.length || values.length > 10) return [];
  const parsed = z.array(z.object({
    instance: z.string().min(1).optional(), baseUrl: z.string().url(), apiKey: z.string().min(1),
    fetchImpl: z.custom<typeof fetch>(value => typeof value === "function").optional(),
  })).safeParse(values);
  if (!parsed.success) return [];
  const connections = parsed.data.map(value => ({ baseUrl: value.baseUrl, apiKey: value.apiKey,
    ...(value.instance !== undefined && { instance: value.instance }),
    ...(value.fetchImpl !== undefined && { fetchImpl: value.fetchImpl }),
  }));
  return new Set(connections.map(value => connectionSource(value).instance)).size === connections.length ? connections : [];
}

export async function withGalaxy(
  instance: string | undefined, connections: GalaxyConnection[],
  run: (connection: GalaxyConnection | undefined) => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  const connection = instance === undefined ? (connections.length === 1 ? connections[0] : undefined)
    : connections.find(value => connectionSource(value).instance === instance);
  if ((!connection && instance !== undefined) || (instance === undefined && connections.length > 1)) {
    return { isError: true, content: [{ type: "text", text:
      `${instance === undefined ? "Choose an instance" : "That instance is not authorized"}. Use get_galaxy_connections, then pass instance explicitly. Authorized aliases: ${connections.map(value => connectionSource(value).instance).join(", ") || "none"}. No Galaxy request was sent.`,
    }] };
  }
  const result = await run(connection);
  if (!connection) return result;
  const galaxy = connectionSource(connection);
  if (!result.structuredContent) return { ...result, content: [...result.content, { type: "text", text: `Galaxy source: ${galaxy.instance} (${galaxy.url})` }] };
  const structuredContent = { ...result.structuredContent, galaxy };
  return { ...result, structuredContent, content: result.content.map((item, index) =>
    index === 0 && item.type === "text" ? { ...item, text: JSON.stringify(structuredContent) } : item) };
}

export function createRequestGalaxyContext(
  connection: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch },
  signal: AbortSignal,
) {
  const fetchImpl = connection.fetchImpl ?? fetch;
  return createGalaxyContext({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    signal,
    fetchImpl: (input, init) => {
      const requestSignal = AbortSignal.any([
        signal,
        ...(input instanceof Request ? [input.signal] : []),
        ...(init?.signal ? [init.signal] : []),
        // Each HTTP exchange has a deadline; a job may still be polled for longer.
        AbortSignal.timeout(60_000),
      ]);
      requestSignal.throwIfAborted();
      return fetchImpl(input, { ...init, redirect: "error", signal: requestSignal });
    },
  });
}
