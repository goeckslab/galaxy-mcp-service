import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readDatasetReport } from "../../apps/service/src/report-reader.js";
import { postModern, startTestService } from "../helpers/service.js";
import { reportPdf } from "../helpers/report.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const html = `<html><head><style>hidden CSS</style><script>sendCredentials()</script></head><body>
<h1>QC &amp; retention</h1><p>Read pairs after filtering.</p><table><caption>Retained pairs</caption>
<tr><th>Sample</th><th>Reads</th></tr><tr><td>A</td><td>900</td></tr></table>
<img alt="Retained pairs plot" src="data:image/png;base64,${png}"><img alt="External plot" src="https://attacker.example/pixel">
<svg><text>Unextracted vector</text></svg><iframe src="https://attacker.example">Untrusted frame</iframe>
<p hidden>Hidden content</p><p>Final warning: sample B needs review.</p></body></html>`;
const args = { datasetId: "d1", page: 1, offset: 0, maxChars: 20_000, includeImage: false, imageIndex: 0 };

function connection(format = "html", content: string | Buffer = html, metadata: Record<string, unknown> = {}) {
  const calls: Request[] = [];
  return {
    calls,
    baseUrl: "https://galaxy.example.test/galaxy/", apiKey: "report-fixture-key",
    fetchImpl: vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      expect(request.headers.get("x-api-key")).toBe("report-fixture-key");
      expect(request.redirect).toBe("error");
      expect(request.url).toMatch(/^https:\/\/galaxy\.example\.test\/galaxy\/api\/datasets\//);
      if (new URL(request.url).pathname.endsWith("/display")) return new Response(typeof content === "string" ? content : new Uint8Array(content));
      return Response.json({ name: "QC report", state: "ok", file_ext: format, ...metadata });
    }),
  };
}

it("returns HTML evidence, table relationships and opt-in images to the model, without fetching assets or executing markup", async () => {
  const before = (await readdir(tmpdir())).filter(name => name.startsWith("galaxy-report-"));
  const conn = connection();
  const result = await readDatasetReport({ ...args, includeImage: true }, conn, new AbortController().signal);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    name: "QC report", extension: "html", url: `${conn.baseUrl}datasets/d1/display`,
    source_sha256: createHash("sha256").update(html).digest("hex"),
    page_count: 1, figure_count: 2, image_returned: true, has_more_text: false,
    figures: [{ index: 0, label: "Retained pairs plot", available: true }, { index: 1, label: "External plot", available: false }],
  });
  const text = String(result.structuredContent?.text);
  expect(text).toContain("# QC & retention");
  expect(text).toContain("\tSample\tReads");
  expect(text).toContain("\tA\t900");
  expect(text).toContain("Final warning");
  expect(text).not.toMatch(/sendCredentials|hidden CSS|Hidden content|Untrusted frame|Unextracted vector|<script/);
  expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: png });
  expect(result).not.toHaveProperty("_meta");
  expect(JSON.stringify(result.structuredContent)).not.toContain(png);
  expect(JSON.stringify(result)).not.toContain("report-fixture-key");
  expect(conn.calls).toHaveLength(2);
  expect((await readdir(tmpdir())).filter(name => name.startsWith("galaxy-report-"))).toEqual(before);
});

it("continues the same HTML/text source without omissions, duplicated prefixes or false completeness", async () => {
  const conn = connection("tsv", "Sample\tCount\nA\t100\nB\t200\nWARNING: last row");
  let offset = 0;
  let combined = "";
  const hashes = new Set();
  do {
    const result = await readDatasetReport({ ...args, offset, maxChars: 9 }, conn, new AbortController().signal);
    expect(result.isError).not.toBe(true);
    const report = result.structuredContent!;
    hashes.add(report.source_sha256);
    combined += report.text;
    expect(report.truncated).toBe(true);
    if (!report.has_more_text) break;
    expect(Number(report.next_offset)).toBeGreaterThan(offset);
    offset = Number(report.next_offset);
  } while (offset < 100);
  expect(combined).toBe("Sample\tCount\nA\t100\nB\t200\nWARNING: last row");
  expect(hashes.size).toBe(1);
});

it("uses Unicode code-point offsets without splitting non-BMP characters or rejecting a full-size excerpt", async () => {
  const conn = connection("txt", "🧪".repeat(50_001));
  const first = await readDatasetReport({ ...args, maxChars: 50_000 }, conn, new AbortController().signal);
  expect(first.structuredContent).toMatchObject({ characters_returned: 50_000, next_offset: 50_000 });
  const last = await readDatasetReport({ ...args, offset: 50_000 }, conn, new AbortController().signal);
  expect(last.structuredContent).toMatchObject({ text: "🧪", characters_returned: 1, has_more_text: false });
});

it("reads real PDF text by page and returns a raster page through MCP image content", async () => {
  const conn = connection("pdf", reportPdf());
  const first = await readDatasetReport({ ...args, includeImage: true }, conn, new AbortController().signal);
  expect(first.isError).not.toBe(true);
  expect(first.structuredContent).toMatchObject({ page: 1, page_count: 3, next_page: 2, truncated: true, image_returned: true });
  expect(first.structuredContent?.text).toContain("QC summary");
  expect(first.structuredContent?.text).toMatch(/A\s+1000\s+900/);
  expect(first.structuredContent?.text).not.toContain("sample B failed");
  const image = first.content.find(block => block.type === "image");
  expect(image).toBeDefined();
  if (image?.type === "image") {
    const bytes = Buffer.from(image.data, "base64");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20))).toBe(2000);
  }
  const second = await readDatasetReport({ ...args, page: 2 }, conn, new AbortController().signal);
  expect(second.structuredContent?.text).toContain("sample B failed");
  expect(second.structuredContent).toMatchObject({ page: 2, page_count: 3, next_page: 3, image_returned: false });
  const imageOnly = await readDatasetReport({ ...args, page: 3, includeImage: true }, conn, new AbortController().signal);
  expect(imageOnly.structuredContent).toMatchObject({ text: "", page: 3, image_returned: true });
  expect(String(imageOnly.structuredContent?.limitations)).toContain("No extractable text");
  expect(imageOnly.structuredContent).not.toHaveProperty("next_page");
});

it.each([
  ["pdf", Buffer.from("not a PDF"), {}, args],
  ["pdf", reportPdf(), {}, { ...args, page: 4 }],
  ["html", html, {}, { ...args, page: 2 }],
  ["txt", "abc", {}, { ...args, offset: 4 }],
  ["fastqsanger", "reads", {}, args],
  ["html", html, { state: "running" }, args],
  ["html", html, { deleted: true }, args],
  ["pdf", reportPdf(), { file_size: 20_000_001 }, args],
] as const)("rejects invalid/unready/out-of-range report input (%s)", async (format, content, metadata, params) => {
  const conn = connection(format, content, metadata);
  const result = await readDatasetReport(params, conn, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
});

it("does not invent missing figures and discloses merged cells and invalid text encoding", async () => {
  const missing = await readDatasetReport({ ...args, includeImage: true, imageIndex: 1 }, connection(), new AbortController().signal);
  expect(missing.structuredContent).toMatchObject({ image_returned: false });
  expect(String(missing.structuredContent?.limitations)).toContain("Requested figure is unavailable");
  const merged = await readDatasetReport(args, connection("html", '<table><tr><td colspan="2">Combined</td></tr></table>'), new AbortController().signal);
  expect(String(merged.structuredContent?.limitations)).toContain("merged cells");
  const encoded = await readDatasetReport(args, connection("txt", Buffer.from([0x61, 0xff])), new AbortController().signal);
  expect(String(encoded.structuredContent?.limitations)).toContain("not valid UTF-8");
});

it("enforces streamed byte limits and does not leave partial report files", async () => {
  const conn = connection();
  conn.fetchImpl.mockImplementationOnce(async () => Response.json({ state: "ok", file_ext: "html" }))
    .mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20_000_001)); } })));
  const result = await readDatasetReport(args, conn, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("20 MB");
});

it("rejects unauthenticated/cancelled reads and tool arguments without touching Galaxy", async () => {
  expect((await readDatasetReport(args, undefined, new AbortController().signal)).isError).toBe(true);
  const conn = connection();
  const controller = new AbortController();
  controller.abort();
  expect((await readDatasetReport(args, conn, controller.signal)).isError).toBe(true);
  expect(conn.calls).toHaveLength(0);
  const service = await startTestService({ galaxy: conn });
  try {
    for (const invalid of [{ page: 0 }, { maxChars: 50_001 }, { offset: -1 }, { imageIndex: 100 }, { url: "https://attacker.example" }]) {
      const response = await postModern(service.baseUrl, "tools/call", { name: "read_dataset_report", arguments: { datasetId: "d1", ...invalid } });
      expect((await response.json()).result.isError).toBe(true);
    }
    expect(conn.calls).toHaveLength(0);
    const response = await postModern(service.baseUrl, "tools/call", { name: "read_dataset_report", arguments: { datasetId: "d1", includeImage: true } });
    const result = (await response.json()).result;
    expect(result.structuredContent.text).toContain("Final warning");
    expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(true);
    expect(service.logs.join(" ")).not.toMatch(/report-fixture-key|Final warning|data:image/);
  } finally { await service.stop(); }
});

it("keeps same-id reports isolated by account and instance, without a shared report cache", async () => {
  const results = await Promise.all(["us", "eu"].map(async instance => {
    const conn = {
      baseUrl: `https://${instance}.example.test`, apiKey: `fixture-${instance}`,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(new URL(request.url).host).toBe(`${instance}.example.test`);
        expect(request.headers.get("x-api-key")).toBe(`fixture-${instance}`);
        return request.url.includes("/display") ? new Response(`Only ${instance} evidence`)
          : Response.json({ state: "ok", file_ext: "txt", name: `${instance} report` });
      },
    };
    return readDatasetReport(args, conn, new AbortController().signal);
  }));
  expect(results[0]?.structuredContent?.text).toBe("Only us evidence");
  expect(results[1]?.structuredContent?.text).toBe("Only eu evidence");
  expect(results[0]?.structuredContent?.source_sha256).not.toBe(results[1]?.structuredContent?.source_sha256);
});

it("bounds concurrent reads, releases capacity after failure, and cancels error responses without buffering them", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const conn = connection();
  conn.fetchImpl.mockImplementation(async () => {
    if (++calls === 2) entered();
    await gate;
    return Response.json({}, { status: 403 });
  });
  const pending = [readDatasetReport(args, conn, new AbortController().signal), readDatasetReport(args, conn, new AbortController().signal)];
  await started;
  const busy = await readDatasetReport(args, conn, new AbortController().signal);
  expect(JSON.stringify(busy)).toContain("busy");
  expect(calls).toBe(2);
  release();
  expect((await Promise.all(pending)).every(result => result.isError)).toBe(true);
  const cancelled = vi.fn();
  const denied = connection();
  denied.fetchImpl.mockImplementationOnce(async () => Response.json({ state: "ok", file_ext: "html" }))
    .mockImplementationOnce(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 403 }));
  const result = await readDatasetReport(args, denied, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(cancelled).toHaveBeenCalledOnce();
  expect((await readDatasetReport(args, connection(), new AbortController().signal)).isError).not.toBe(true);
});

it("bounds malformed HTML structure and oversized/missing embedded figures", async () => {
  const nested = await readDatasetReport(args, connection("html", "<div>".repeat(300) + "nested"), new AbortController().signal);
  expect(nested.isError).toBe(true);
  const invalid = await readDatasetReport({ ...args, includeImage: true }, connection("html", '<h1>Report</h1><img alt="fake" src="data:image/png;base64,YWJj">'), new AbortController().signal);
  expect(invalid.structuredContent).toMatchObject({ image_returned: false, figures: [{ index: 0, available: false }] });
  const many = await readDatasetReport(args, connection("html", '<img alt="omitted" src="https://example.test/image">'.repeat(105)), new AbortController().signal);
  expect(many.structuredContent?.figure_count).toBe(105);
  expect(many.structuredContent?.figures).toHaveLength(100);
  expect(String(many.structuredContent?.limitations)).toContain("first 100");
});
