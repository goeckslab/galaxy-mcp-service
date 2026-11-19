import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createRequestGalaxyContext, instanceInput, requestFetch, sourceOutput, withGalaxy, type GalaxyConnection } from "./galaxy-connection.js";

// A file never passes through this service. The service opens a resumable upload on the
// Galaxy site with the user's key; the card (from the browser) or the assistant (from its own
// code environment, for a file attached to the chat) sends the bytes straight to that upload,
// and the service then asks Galaxy to turn the finished upload into a dataset. Galaxy checks the key when an upload is created; the
// upload's address is what authorizes its chunks, so the key never reaches the browser.

/** Galaxy's own web client uploads in chunks of this size. */
export const UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024;
const TUS = { "Tus-Resumable": "1.0.0" };
const session = /^[A-Za-z0-9+._-]{8,200}$/;
const historyId = z.string().trim().min(1).max(256).describe("Encoded id of the history that receives the file");
const fileName = z.string().trim().min(1).max(255).refine(value => !/[\\/\p{Cc}]/u.test(value), "A file name without a path").describe("The file's name, without a path");

const startInput = z.object({
  historyId, fileName,
  size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe("File size in bytes"),
}).strict();
const startOutput = z.object({
  success: z.boolean(),
  upload: z.object({
    url: z.string().url().describe("Send the file here in order, as tus PATCH requests: Tus-Resumable 1.0.0, Content-Type application/offset+octet-stream, Upload-Offset = bytes sent so far, at most chunk_bytes per request. No API key is needed."),
    session_id: z.string(),
    chunk_bytes: z.number().int(),
  }).optional(),
  message: z.string(),
});
const finishInput = z.object({ historyId, fileName, sessionId: z.string().regex(session).describe("session_id from start_file_upload") }).strict();
const finishOutput = z.object({
  success: z.boolean(),
  data: z.object({
    outputs: z.array(z.object({ id: z.string(), name: z.string().optional(), hid: z.number().int().optional() })),
    jobs: z.array(z.object({ id: z.string(), state: z.string().optional() })),
  }).optional(),
  message: z.string(),
});

function result(value: z.infer<typeof startOutput> | z.infer<typeof finishOutput>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(!value.success && { isError: true }) };
}
const failed = (message: string) => result({ success: false, message });
const notConnected = () => failed("Connect a Galaxy account before using this tool.");

function uploadEndpoint(connection: GalaxyConnection): URL {
  return new URL("api/upload/resumable_upload/", connection.baseUrl.endsWith("/") ? connection.baseUrl : `${connection.baseUrl}/`);
}

/** The created upload, only if it is on the same Galaxy site under the upload endpoint. */
export function createdUpload(location: string | null, endpoint: URL): { url: string; sessionId: string } | undefined {
  if (!location) return undefined;
  let url: URL;
  try { url = new URL(location, endpoint); } catch { return undefined; }
  // An upload server behind Galaxy's proxy may name itself with http.
  if (url.host === endpoint.host) url.protocol = endpoint.protocol;
  const sessionId = url.pathname.startsWith(endpoint.pathname) ? url.pathname.slice(endpoint.pathname.length) : "";
  if (url.origin !== endpoint.origin || url.username || url.password || url.search || url.hash || !session.test(sessionId)) return undefined;
  return { url: url.href, sessionId };
}

async function startFileUpload(args: z.infer<typeof startInput>, connection: GalaxyConnection | undefined, signal: AbortSignal): Promise<CallToolResult> {
  if (connection === undefined) return notConnected();
  const endpoint = uploadEndpoint(connection);
  let response: Response;
  try {
    response = await requestFetch(connection, signal)(endpoint, { method: "POST", headers: {
      ...TUS, "x-api-key": connection.apiKey, "Upload-Length": String(args.size),
      "Upload-Metadata": `filename ${Buffer.from(args.fileName).toString("base64")}`,
    } });
  } catch { return failed("Galaxy could not be reached to start the upload."); }
  if (response.status === 413) return failed("This file is larger than this Galaxy site accepts.");
  const upload = response.status === 201 ? createdUpload(response.headers.get("location"), endpoint) : undefined;
  if (!upload) return failed("Galaxy did not start the upload.");
  return result({
    success: true,
    upload: { url: upload.url, session_id: upload.sessionId, chunk_bytes: UPLOAD_CHUNK_BYTES },
    message: "Upload started. Send the file straight to Galaxy at upload.url, then call finish_file_upload.",
  });
}

async function finishFileUpload(args: z.infer<typeof finishInput>, connection: GalaxyConnection | undefined, signal: AbortSignal): Promise<CallToolResult> {
  if (connection === undefined) return notConnected();
  // A partial upload would become a silently truncated dataset.
  let status: Response;
  try {
    status = await requestFetch(connection, signal)(new URL(args.sessionId, uploadEndpoint(connection)), { method: "HEAD", headers: TUS });
  } catch { return failed("Galaxy could not be reached to check the upload."); }
  const received = Number(status.headers.get("upload-offset") ?? NaN);
  const expected = Number(status.headers.get("upload-length") ?? NaN);
  if (!status.ok || !Number.isSafeInteger(received) || !Number.isSafeInteger(expected)) return failed("Galaxy no longer has this upload. Start it again.");
  if (received !== expected) return failed(`The upload is incomplete: Galaxy has ${received} of ${expected} bytes. No dataset was created.`);
  // The request Galaxy's own client sends after a resumable upload.
  const created = await createRequestGalaxyContext(connection, signal).client.POST("/api/tools/fetch", { body: {
    history_id: args.historyId, auto_decompress: true,
    targets: [{ destination: { type: "hdas" }, auto_decompress: true, elements: [{ src: "files", name: args.fileName, ext: "auto", dbkey: "?" }] }],
    "files_0|file_data": { session_id: args.sessionId, name: args.fileName },
  } as never });
  const data = created.data as { outputs?: unknown; jobs?: unknown } | undefined;
  const parsed = finishOutput.shape.data.unwrap().safeParse({ outputs: data?.outputs ?? [], jobs: data?.jobs ?? [] });
  if (created.error || !data || !parsed.success) {
    const reason = (created.error as { err_msg?: unknown } | undefined)?.err_msg;
    return failed(typeof reason === "string" ? `Galaxy did not add the file: ${reason}` : "Galaxy did not add the file.");
  }
  return result({ success: true, data: parsed.data, message: `Galaxy is adding ${args.fileName} to the history.` });
}

export function registerLocalUpload(server: McpServer, connections: GalaxyConnection[]) {
  // The card's Upload button uses these, and so can the assistant when its own code environment
  // can reach the Galaxy site: it then sends a chat attachment's bytes straight to Galaxy.
  const shared = {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["model", "app"] } },
  };
  server.registerTool("start_file_upload", {
    ...shared,
    description: "Open a resumable upload on the Galaxy site for one file. Use it for a file attached to the chat only when you can run code that reaches the Galaxy site: send the bytes from your code environment to upload.url with tus PATCH requests (no API key; the address authorizes them), then call finish_file_upload. The bytes never pass through this service or your context. If your code cannot reach the site, ask the user to use the history card's Upload button instead. The Galaxy card's Upload button also uses this tool.",
    inputSchema: startInput.extend(instanceInput), outputSchema: startOutput.extend(sourceOutput),
  }, ({ instance, ...args }, ctx) => withGalaxy(instance, connections, connection => startFileUpload(args, connection, ctx.mcpReq.signal)));
  server.registerTool("finish_file_upload", {
    ...shared,
    description: "After the whole file has reached upload.url, add it to the history as a dataset. Galaxy detects the format. An incomplete upload creates nothing; it reports how many bytes Galaxy has.",
    inputSchema: finishInput.extend(instanceInput), outputSchema: finishOutput.extend(sourceOutput),
  }, ({ instance, ...args }, ctx) => withGalaxy(instance, connections, connection => finishFileUpload(args, connection, ctx.mcpReq.signal)));
}
