import { afterEach, describe, expect, it } from "vitest";

import { postModern, startTestService } from "../helpers/service.js";

const galaxy = { instance: "galaxy.example.test", url: "https://galaxy.example.test" };
let stop: () => Promise<void> = async () => undefined;
afterEach(async () => { await stop(); stop = async () => undefined; });

type Dataset = { id: string; hid: number; name: string; state: string };

/** A Galaxy whose history returns each listed page in turn, then keeps returning the last one. */
async function service(pages: Dataset[][]) {
  const queries: URLSearchParams[] = [];
  const started = await startTestService({ galaxy: {
    baseUrl: galaxy.url, apiKey: "wait-fixture-key",
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/histories/h1/contents") {
        queries.push(url.searchParams);
        return Response.json(pages[Math.min(queries.length - 1, pages.length - 1)]);
      }
      return Response.json({ err_msg: "Unexpected request" }, { status: 404 });
    },
  } });
  stop = started.stop;
  const call = async (args: Record<string, unknown>) =>
    (await (await postModern(started.baseUrl, "tools/call", { name: "wait_for_datasets", arguments: args })).json()).result as { isError?: boolean; structuredContent: Record<string, unknown> };
  return { queries, call };
}

const cycle = (n: number, state: string): Dataset => ({ id: `d${n}`, hid: n, name: `cycle-${n}.tif`, state });

describe("waiting for datasets", () => {
  it("returns as soon as the requested datasets are ready, reading only non-deleted datasets", async () => {
    const { queries, call } = await service([[cycle(2, "running"), cycle(1, "ok")], [cycle(2, "ok"), cycle(1, "ok")]]);
    const waited = await call({ historyId: "h1", datasetIds: ["d1", "d2"], timeoutSeconds: 10 });
    expect(waited.structuredContent).toEqual({
      success: true, galaxy, message: "All 2 dataset(s) are ready.",
      data: { done: true, ready: 2, processing: 0, failed: 0, missing: [], waited_seconds: expect.any(Number), items: [] },
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]!.get("v")).toBe("dev");
    expect([queries[0]!.getAll("q"), queries[0]!.getAll("qv")]).toEqual([["deleted", "history_content_type"], ["false", "dataset"]]);
  }, 15_000);

  it("reports what is still processing when the wait ends, and tells the assistant to keep waiting", async () => {
    const { call } = await service([[cycle(3, "queued"), cycle(2, "upload"), cycle(1, "ok")]]);
    const waited = await call({ historyId: "h1", timeoutSeconds: 1 });
    expect(waited.structuredContent.data).toMatchObject({
      done: false, ready: 0, processing: 2, failed: 0,
      items: [{ id: "d3", hid: 3, name: "cycle-3.tif", state: "queued" }, { id: "d2", hid: 2, name: "cycle-2.tif", state: "upload" }],
    });
    expect(waited.structuredContent.message).toContain("Call wait_for_datasets again");
  });

  it("stops waiting on a failure and names missing ids", async () => {
    const { call } = await service([[cycle(2, "error"), cycle(1, "ok")]]);
    const waited = await call({ history_id: "h1", dataset_ids: ["d1", "d2", "gone"], timeout_seconds: 5 });
    expect(waited.structuredContent.data).toMatchObject({
      done: true, ready: 1, processing: 0, failed: 1, missing: ["gone"], items: [{ id: "d2", state: "error" }],
    });
    expect(waited.structuredContent.message).toContain("failed or are paused");
  });
});
