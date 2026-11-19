import { afterEach, describe, expect, it } from "vitest";

import { createdUpload } from "../../apps/service/src/local-upload.js";
import { postModern, startTestService } from "../helpers/service.js";

const apiKey = "upload-fixture-key";
const galaxy = { instance: "galaxy.example.test", url: "https://galaxy.example.test" };
let stop: () => Promise<void> = async () => undefined;
afterEach(async () => { await stop(); stop = async () => undefined; });

async function service(received: number, location = "http://galaxy.example.test/api/upload/resumable_upload/0123456789abcdef") {
  const requests: Array<{ method: string; path: string; headers: Headers; body: string }> = [];
  const started = await startTestService({ galaxy: {
    baseUrl: galaxy.url, apiKey,
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { pathname } = new URL(request.url);
      requests.push({ method: request.method, path: pathname, headers: request.headers, body: request.method === "POST" ? await request.clone().text() : "" });
      if (request.method === "POST" && pathname === "/api/upload/resumable_upload/") return new Response(null, { status: 201, headers: { location } });
      if (request.method === "HEAD" && pathname === "/api/upload/resumable_upload/0123456789abcdef") {
        return new Response(null, { headers: { "upload-offset": String(received), "upload-length": "12" } });
      }
      if (request.method === "HEAD") return new Response(null, { status: 404 });
      if (request.method === "POST" && pathname === "/api/tools/fetch") {
        return Response.json({ outputs: [{ id: "d9", name: "counts.tsv", hid: 4, state: "queued" }], jobs: [{ id: "j9", state: "new", tool_id: "__DATA_FETCH__" }] });
      }
      return Response.json({ err_msg: "Unexpected request" }, { status: 404 });
    },
  } });
  stop = started.stop;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await (await postModern(started.baseUrl, "tools/call", { name, arguments: args })).json()).result as { isError?: boolean; structuredContent: Record<string, unknown> };
  return { requests, call, logs: started.logs };
}

describe("uploading a local file straight to Galaxy", () => {
  it("opens the upload with the user's key, hands the card only its address, and adds the finished file to the history", async () => {
    const { requests, call, logs } = await service(12);
    const start = await call("start_file_upload", { history_id: "h1", file_name: "counts.tsv", size: 12 });
    expect(start.structuredContent).toEqual({
      success: true, galaxy,
      // The upload server named itself with http behind Galaxy's proxy.
      upload: { url: "https://galaxy.example.test/api/upload/resumable_upload/0123456789abcdef", session_id: "0123456789abcdef", chunk_bytes: 10 * 1024 * 1024 },
      message: "Upload started. Send the file straight to Galaxy at upload.url, then call finish_file_upload.",
    });
    expect(JSON.stringify(start)).not.toContain(apiKey);
    expect(Object.fromEntries(requests[0]!.headers)).toMatchObject({
      "x-api-key": apiKey, "tus-resumable": "1.0.0", "upload-length": "12", "upload-metadata": `filename ${Buffer.from("counts.tsv").toString("base64")}`,
    });

    const finish = await call("finish_file_upload", { historyId: "h1", fileName: "counts.tsv", sessionId: "0123456789abcdef" });
    expect(finish.structuredContent).toEqual({
      success: true, galaxy, message: "Galaxy is adding counts.tsv to the history.",
      data: { outputs: [{ id: "d9", name: "counts.tsv", hid: 4 }], jobs: [{ id: "j9", state: "new" }] },
    });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/upload/resumable_upload/", "HEAD /api/upload/resumable_upload/0123456789abcdef", "POST /api/tools/fetch",
    ]);
    // The check of what Galaxy received needs no key.
    expect(requests[1]!.headers.get("x-api-key")).toBeNull();
    expect(JSON.parse(requests[2]!.body)).toEqual({
      history_id: "h1", auto_decompress: true,
      targets: [{ destination: { type: "hdas" }, auto_decompress: true, elements: [{ src: "files", name: "counts.tsv", ext: "auto", dbkey: "?" }] }],
      "files_0|file_data": { session_id: "0123456789abcdef", name: "counts.tsv" },
    });
    expect(logs.join("\n")).not.toContain(apiKey);
  });

  it("creates no dataset from a partial or unknown upload", async () => {
    const { requests, call } = await service(5);
    const partial = await call("finish_file_upload", { historyId: "h1", fileName: "counts.tsv", sessionId: "0123456789abcdef" });
    expect(partial).toMatchObject({ isError: true, structuredContent: { success: false, message: "The upload is incomplete: Galaxy has 5 of 12 bytes. No dataset was created." } });
    const unknown = await call("finish_file_upload", { historyId: "h1", fileName: "counts.tsv", sessionId: "ffffffffffffffff" });
    expect(unknown).toMatchObject({ isError: true, structuredContent: { message: "Galaxy no longer has this upload. Start it again." } });
    expect(requests.every(request => request.method === "HEAD")).toBe(true);
  });

  it("refuses paths, empty files and session ids that could address something else, without contacting Galaxy", async () => {
    const { requests, call } = await service(12);
    for (const [name, args] of [
      ["start_file_upload", { historyId: "h1", fileName: "../counts.tsv", size: 12 }],
      ["start_file_upload", { historyId: "h1", fileName: "counts.tsv", size: 0 }],
      ["finish_file_upload", { historyId: "h1", fileName: "counts.tsv", sessionId: "../../histories" }],
      ["finish_file_upload", { historyId: "h1", fileName: "counts.tsv", sessionId: "0123456789abcdef?x=1" }],
    ] as const) expect((await call(name, args)).isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it.each([
    "https://attacker.example/api/upload/resumable_upload/0123456789abcdef",
    "https://galaxy.example.test/api/histories/0123456789abcdef",
    "https://galaxy.example.test/api/upload/resumable_upload/0123456789abcdef?next=https://attacker.example",
    "https://user:secret@galaxy.example.test/api/upload/resumable_upload/0123456789abcdef",
    "https://galaxy.example.test/api/upload/resumable_upload/../../histories/h1",
  ])("does not hand the card an upload address outside the Galaxy upload endpoint: %s", async location => {
    expect(createdUpload(location, new URL("https://galaxy.example.test/api/upload/resumable_upload/"))).toBeUndefined();
    const { call } = await service(12, location);
    expect(await call("start_file_upload", { historyId: "h1", fileName: "counts.tsv", size: 12 })).toMatchObject({
      isError: true, structuredContent: { success: false, message: "Galaxy did not start the upload." },
    });
  });
});
