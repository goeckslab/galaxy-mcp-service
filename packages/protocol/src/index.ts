import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

const sensitiveKey = /(authorization|cookie|credential|password|secret|token|api[_-]?key)/i;
const safeIdentifier = /^[A-Za-z0-9._-]{1,128}$/;

type UnknownRecord = Record<string, unknown>;

export interface HeaderMismatch {
  code: -32020;
  message: string;
  data: { mismatch: { header: string; body: string } };
}

export interface RequestMetadata {
  timestamp: string;
  request_id: string;
  http_method: string;
  mcp_protocol_version?: string;
  mcp_method?: string;
  mcp_name?: string;
  body_method?: string;
  body_name_or_task_id?: string;
  client_info?: { name?: string; version?: string };
  client_capabilities: string[];
  server_discover_seen: boolean;
  initialize_seen: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && safeIdentifier.test(value) ? value : undefined;
}

function cleanClientInfo(value: unknown): { name?: string; version?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const name = cleanIdentifier(value.name);
  const version = cleanIdentifier(value.version);
  return name === undefined && version === undefined ? undefined : { ...(name && { name }), ...(version && { version }) };
}

function cleanCapabilityNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const rawNames = Object.keys(value);
  const names = rawNames.flatMap((name) => cleanIdentifier(name) ?? []);
  if (names.length !== rawNames.length) names.push("[redacted]");
  return [...new Set(names)].sort().slice(0, 50);
}

function requestParams(body: unknown): UnknownRecord | undefined {
  return isRecord(body) && isRecord(body.params) ? body.params : undefined;
}

function requestMeta(body: unknown): UnknownRecord | undefined {
  const params = requestParams(body);
  return params && isRecord(params._meta) ? params._meta : undefined;
}

export function requestId(value?: string | null): string {
  return value !== undefined && value !== null && safeIdentifier.test(value) ? value : randomUUID();
}

/**
 * SDK v2 validates the other modern routing headers itself. Its protocol-version
 * header is only a cross-check, while this service requires it for modern requests.
 */
export function requireModernProtocolHeader(body: unknown, headerValue?: string): HeaderMismatch | undefined {
  const claimedVersion = requestMeta(body)?.[PROTOCOL_VERSION_META_KEY];
  if (typeof claimedVersion !== "string") return undefined;
  if (headerValue === claimedVersion) return undefined;
  return {
    code: -32020,
    message: "HeaderMismatch: MCP-Protocol-Version must match the request _meta envelope",
    data: {
      mismatch: {
        header: headerValue ?? "(missing)",
        body: claimedVersion,
      },
    },
  };
}

export function extractRequestMetadata(
  body: unknown,
  headers: Pick<Headers, "get">,
  httpMethod: string,
  id: string,
): RequestMetadata {
  const params = requestParams(body);
  const meta = requestMeta(body);
  const clientCapabilities = meta?.[CLIENT_CAPABILITIES_META_KEY];
  const bodyMethod = isRecord(body) ? cleanIdentifier(body.method) : undefined;
  const bodyName = cleanIdentifier(params?.name) ?? cleanIdentifier(params?.taskId);
  const protocolVersion = cleanIdentifier(headers.get("mcp-protocol-version"));
  const methodHeader = cleanIdentifier(headers.get("mcp-method"));
  const nameHeader = cleanIdentifier(headers.get("mcp-name"));
  const clientInfo = meta === undefined ? undefined : cleanClientInfo(meta[CLIENT_INFO_META_KEY]);

  return {
    timestamp: new Date().toISOString(),
    request_id: id,
    http_method: httpMethod,
    ...(protocolVersion && { mcp_protocol_version: protocolVersion }),
    ...(methodHeader && { mcp_method: methodHeader }),
    ...(nameHeader && { mcp_name: nameHeader }),
    ...(bodyMethod && { body_method: bodyMethod }),
    ...(bodyName && { body_name_or_task_id: bodyName }),
    ...(clientInfo !== undefined && { client_info: clientInfo }),
    client_capabilities: cleanCapabilityNames(clientCapabilities),
    server_discover_seen: bodyMethod === "server/discover",
    initialize_seen: bodyMethod === "initialize",
  };
}

function hasCredentialBearingUrl(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.username !== "" ||
      url.password !== "" ||
      [...url.searchParams.keys()].some((key) => sensitiveKey.test(key))
    );
  } catch {
    return false;
  }
}

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return hasCredentialBearingUrl(value) ? "[redacted-url]" : value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[redacted]" : redactSecrets(item, seen)]),
  );
}

export function metadataLog(metadata: unknown, sink: (line: string) => void = console.log): void {
  sink(JSON.stringify(redactSecrets(metadata)));
}
