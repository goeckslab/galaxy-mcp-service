import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { HISTORY_SUMMARY_URI, registerHistorySummaryResource } from "../../apps/service/src/history-summary-ui.js";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, unknown> & { setProperty(name: string, value: string): void } = {
    setProperty(name, value) { this[name] = value; },
  };
  attrs = new Map<string, string>();
  listeners = new Map<string, (event: { preventDefault: () => void }) => unknown>();
  hidden = false;
  disabled = false;
  focused = false;
  removed = false;
  className = "";
  tabIndex = -1;
  open = false;
  value = "";
  namespaceURI = "http://www.w3.org/1999/xhtml";
  parentElement?: Element;
  private text = "";
  constructor(public tagName: string) {}
  get nodeType() { return this.tagName === "#text" ? 3 : 1; }
  get childNodes(): Element[] {
    const text = new Element("#text");
    text.textContent = this.text;
    return [...(this.text ? [text] : []), ...this.children];
  }
  querySelector(tag: string): Element | undefined {
    for (const child of this.children) {
      if (child.tagName.toLowerCase() === tag) return child;
      const match = child.querySelector(tag);
      if (match) return match;
    }
  }
  get childElementCount() { return this.children.length; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get outerHTML() { return "<html></html>"; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  append(...children: Element[]) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  prepend(...children: Element[]) { for (const child of children) child.parentElement = this; this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.text = ""; this.children = []; this.append(...children); }
  addEventListener(name: string, listener: (event: { preventDefault: () => void }) => unknown) { this.listeners.set(name, listener); }
  click(event = { preventDefault() {} }) { return this.listeners.get("click")?.(event); }
  focus() { this.focused = true; }
  remove() { this.removed = true; }
  getBoundingClientRect() { return { height: 500 }; }
}

interface Rpc {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
}

/** What the card passes to fetch for an upload request. */
interface FetchInit { method: string; headers: Record<string, string>; body: { bytes: number }; credentials: string; signal: AbortSignal }

const resources = new Map<string, string>();
registerHistorySummaryResource({
  registerResource(_name: string, uri: string, _metadata: unknown, read: (uri: URL) => { contents: { text: string }[] }) {
    resources.set(uri, read(new URL(uri)).contents[0]!.text);
  },
} as unknown as Parameters<typeof registerHistorySummaryResource>[0], undefined, "https://mcp.example.org");
const html = resources.get(HISTORY_SUMMARY_URI)!;
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

function mount(initial?: unknown, options: { initialize?: boolean; initializeResult?: unknown; standardHost?: boolean; intersectionObserver?: boolean; reply?: (rpc: Rpc) => unknown; elements?: Element[]; htmlText?: string; fetch?: (url: string, init: FetchInit) => unknown } = {}) {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element("DIV")]));
  const root = new Element("HTML");
  const head = new Element("HEAD");
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Map<string, (event: unknown) => void>();
  const documentListeners = new Map<string, (event: unknown) => void>();
  const observers: { callback: (entries: { isIntersecting: boolean }[]) => void; active: boolean }[] = [];
  const calls: Rpc[] = [];
  let timerId = 0;
  const emit = (name: string, event: unknown) => listeners.get(name)?.(event);
  const parent = {
    postMessage(rpc: Rpc) {
      calls.push(rpc);
      if (rpc.method === "ui/initialize" && options.initialize !== false) reply(rpc, options.initializeResult ?? {});
      else if (rpc.method === "tools/call" && options.reply) reply(rpc, options.reply(rpc));
      else if (rpc.method === "ui/update-model-context") reply(rpc, {});
    },
  };
  function reply(rpc: Rpc, result: unknown) {
    emit("message", { source: parent, data: { jsonrpc: "2.0", id: rpc.id, result } });
  }
  const document = {
    getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new Element(tag.toUpperCase()),
    createTextNode: (value: string) => { const node = new Element("#text"); node.textContent = value; return node; }, documentElement: root,
    visibilityState: "visible", hidden: false,
    addEventListener: (name: string, callback: (event: unknown) => void) => documentListeners.set(name, callback),
  };
  const context = createContext({
    URL, AbortController, ...(options.fetch && { fetch: options.fetch }),
    window: { parent, ...(options.standardHost ? {} : { openai: { toolOutput: initial, theme: "light" } }) },
    document,
    addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    ...(options.intersectionObserver === false ? {} : { IntersectionObserver: class {
      active = false;
      constructor(public callback: (entries: { isIntersecting: boolean }[]) => void) { observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    } }),
    DOMParser: class {
      parseFromString() {
        const body = new Element("BODY");
        body.textContent = options.htmlText ?? "";
        body.append(...options.elements ?? []);
        return { body };
      }
    },
  });
  runInContext(script, context);
  return {
    node: (id: string) => nodes.get(id)!, root, head, calls, timers, reply,
    reject: (rpc: Rpc, error: unknown) => emit("message", { source: parent, data: { jsonrpc: "2.0", id: rpc.id, error } }),
    pending: () => runInContext("pending.size", context) as number,
    /** A network failure as the page's own script sees it. */
    networkError: () => runInContext('new TypeError("Failed to fetch")', context) as Error,
    choose: (file: unknown) => {
      Object.assign(nodes.get("upload-input")!, { files: [file] });
      return nodes.get("upload-input")!.listeners.get("change")?.({ preventDefault() {} });
    },
    notify: (value: unknown) => emit("message", { source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: value } } }),
    hostContext: (value: unknown) => emit("message", { source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: value } }),
    teardown: (id = 1000000) => emit("message", { source: parent, data: { jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} } }),
    visibility: (visible: boolean) => {
      document.visibilityState = visible ? "visible" : "hidden";
      document.hidden = !visible;
      documentListeners.get("visibilitychange")?.({});
    },
    intersect: (visible: boolean) => { for (const observer of observers) if (observer.active) observer.callback([{ isIntersecting: visible }]); },
    globals: (value: unknown) => emit("openai:set_globals", { detail: { globals: value } }),
    resize: () => emit("resize", {}),
    close: () => emit("pagehide", {}),
    cache: () => emit("pagehide", { persisted: true }),
    restore: () => emit("pageshow", { persisted: true }),
    preview: () => runInContext('reportPreview("<fixture>")', context) as { preview: Element; limited: boolean },
    expire: (delay: number) => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
  };
}

const items = (count: number, start = 0) => Array.from({ length: count }, (_, index) => ({ id: "private-dataset-" + (start + index), name: "Result " + (start + index), state: "ok", extension: "txt" }));
const historyResult = { status: "connected", histories: [{ id: "private-history", name: "RNA analysis", state: "ok" }] };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("history result browser", () => {
  it.each([false, true])("only displays known history and dataset states (standard host=%s)", async standardHost => {
    const data = [undefined, null, "unknown", "ok", "error"].map((state, index) => ({ ...items(1, index)[0], state, extension: "bam" }));
    const badges = (node: Element): Element[] => [
      ...(["state", "status"].includes(node.className) ? [node] : []),
      ...node.children.flatMap(badges),
    ];
    const ui = mount(undefined, {
      standardHost, initializeResult: { hostCapabilities: { serverTools: {} } },
      reply: rpc => rpc.params?.name === "get_dataset_details"
        ? { structuredContent: { success: true, data: { id: rpc.params.arguments?.datasetId, file_ext: "bam", file_size: 64 } } }
        : { isError: true },
    });
    await flush();
    for (const result of [{ status: "connected", histories: data }, { success: true, data }]) {
      ui.notify(result);
      expect(ui.node("histories").children).toHaveLength(5);
      expect(badges(ui.node("histories")).map(node => node.textContent)).toEqual(["Ready", "Failed"]);
    }
    await ui.node("histories").children[3]!.children[0]!.click();
    await flush();
    expect(ui.node("detail-body").querySelector("dl")?.children.map(node => node.querySelector("dt")?.textContent)).toEqual(["Format", "Size"]);
  });

  it("previews PDF pages, images, tables and JSON in one viewer, and falls back to Galaxy peek for binary data", async () => {
    const galaxy = { instance: "us", url: "https://usegalaxy.org" };
    const formats = ["pdf", "png", "csv", "json", "bam"];
    let changed = false;
    const ui = mount({ success: true, galaxy, data: formats.map((extension, index) => ({ ...items(1, index)[0], extension })) }, {
      initializeResult: { hostCapabilities: { serverTools: {}, updateModelContext: {} } },
      reply: rpc => {
        const id = String(rpc.params?.arguments?.datasetId);
        const format = formats[Number(id.split("-").at(-1))];
        if (rpc.params?.name === "get_dataset_details") return { structuredContent: { success: true, galaxy, data: { id, file_ext: "bam", state: "ok", peek: "Galaxy BAM summary" } } };
        if (format === "bam") return { isError: true };
        return {
          structuredContent: { galaxy, dataset_id: id, url: galaxy.url + "/datasets/" + id + "/display", name: format + " result", extension: format,
            preview_kind: format === "png" ? "image" : format, source_sha256: (changed ? "b" : "a").repeat(64),
            text: format === "png" ? "" : format === "json" ? '{"sample":"<script>not executable</script>","reads":900}' : "Source text", page: Number(rpc.params?.arguments?.page || 1), page_count: format === "pdf" ? 2 : 1,
          },
          ...(format === "pdf" || format === "png" ? { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] } : {}),
          ...(format === "csv" ? { _meta: { preview: { kind: "table", rows: [["sample", "reads"], ["<script>literal cell</script>", "900"]] } } } : {}),
        };
      }, htmlText: "Galaxy BAM summary",
    });
    await flush();
    expect(ui.node("histories").children.every(row => row.dataset.clickable === "true")).toBe(true);
    for (const [index, format] of formats.entries()) {
      await ui.node("histories").children[index]!.children[0]!.click();
      await flush();
      expect(ui.node("report-link").hidden).toBe(false);
      if (format === "pdf") {
        expect(ui.node("detail-message").textContent).toBe("Page 1 of 2");
        const zoom = ui.node("detail-body").children[0]!;
        const image = ui.node("detail-body").querySelector("img")!;
        expect(zoom.textContent).toBe("Actual size");
        await zoom.click();
        expect(image.dataset.actual).toBe("true");
        expect(zoom.textContent).toBe("Fit page");
        await zoom.click();
        expect(image.dataset.actual).toBe("false");
        const scroller = image.parentElement!;
        scroller.getBoundingClientRect = () => ({ height: 150 });
        ui.hostContext({ containerDimensions: { maxHeight: 900 } });
        expect(scroller.style["--figure-height"]).toBe("550px");
        ui.hostContext({ theme: "light" });
        expect(scroller.style["--figure-height"]).toBe("550px");
        ui.hostContext({ containerDimensions: { height: 500 } });
        expect(scroller.style["--figure-height"]).toBe("150px");
        ui.hostContext({ containerDimensions: {} });
        expect(scroller.style["--figure-height"]).toBe("620px");
        await ui.node("detail-body").children.at(-1)!.children[0]!.click();
        expect(ui.node("detail-message").textContent).toBe("Page 2 of 2");
        const previous = ui.node("detail-body").children.at(-1)!.children[0]!;
        expect(previous.textContent).toBe("Previous page");
        await previous.click();
        expect(ui.node("detail-message").textContent).toBe("Page 1 of 2");
        const lastImage = ui.node("detail-body").querySelector("img");
        changed = true;
        await ui.node("detail-body").children.at(-1)!.children[0]!.click();
        expect(ui.node("detail-message").textContent).toContain("last loaded preview is retained");
        expect(ui.node("detail-body").querySelector("img")).toBe(lastImage);
        changed = false;
      } else if (format === "png") {
        expect(ui.node("detail-body").querySelector("img")?.attrs.get("src")).toContain("data:image/png;base64,");
        expect(ui.node("detail-body").querySelector("pre")).toBeUndefined();
      }
      else if (format === "csv") expect(ui.node("detail-body").querySelector("table")?.textContent).toContain("<script>literal cell</script>");
      else if (format === "json") expect(ui.node("detail-body").querySelector("pre")?.textContent).toContain('\n  "reads": 900');
      else expect(ui.node("detail-body").textContent).toContain("Galaxy BAM summary");
      expect(ui.node("detail-body").querySelector("script")).toBeUndefined();
      await ui.node("detail-close").click();
    }
    expect(ui.calls.filter(call => call.method === "tools/call").every(call => ["read_dataset_report", "get_dataset_details"].includes(call.params?.name || ""))).toBe(true);
    expect(ui.calls.filter(call => call.method === "tools/call").every(call => call.params?.arguments?.instance === "us")).toBe(true);
    ui.teardown();
  });

  it("does not rerender a workspace or echo unchanged size when the host replays its result", async () => {
    const us = { instance: "us", url: "https://usegalaxy.org" };
    const result = {
      view: "workspace", connections: [us], presentation: { view_id: "workspace-1" },
      initial: { ...historyResult, galaxy: us },
    };
    const ui = mount(result, { initializeResult: { hostCapabilities: { serverTools: {}, updateModelContext: {} } } });
    await flush();
    const row = ui.node("histories").children[0];
    const callCount = ui.calls.length;
    expect(row?.textContent).toContain("RNA analysis");
    for (let replay = 0; replay < 3; replay++) {
      ui.globals({ toolOutput: result, theme: "dark" });
      ui.notify(result);
      ui.resize();
    }
    expect(ui.node("histories").children[0]).toBe(row);
    expect(ui.calls).toHaveLength(callCount);
    expect(ui.root.style.colorScheme).toBe("dark");
    ui.notify({ ...result, presentation: { view_id: "workspace-2" }, initial: { ...result.initial, histories: [{ id: "new-history", name: "New analysis" }] } });
    expect(ui.node("histories").textContent).toContain("New analysis");
    ui.root.getBoundingClientRect = () => ({ height: 650 });
    ui.resize();
    expect(ui.calls.at(-1)?.params).toEqual({ height: 650 });
  });

  it("reuses the workspace without extra cards, binds site selection, and rejects stale cross-site results", async () => {
    const us = { instance: "us", url: "https://usegalaxy.org" };
    const eu = { instance: "eu", url: "https://usegalaxy.eu" };
    const ui = mount({ view: "workspace", connections: [us, eu], management_available: true }, {
      initializeResult: { hostCapabilities: { serverTools: {}, updateModelContext: {} } },
    });
    await flush();
    expect(ui.node("workspace-nav").hidden).toBe(false);
    expect(ui.node("workspace-site").children.map(value => value.textContent)).toEqual(["Choose a Galaxy site", "us · usegalaxy.org", "eu · usegalaxy.eu"]);
    expect(ui.node("histories").children).toHaveLength(0);
    ui.node("workspace-site").value = "us";
    const first = ui.node("workspace-site").listeners.get("change")!({ preventDefault() {} });
    const usRead = ui.calls.find(call => call.params?.name === "get_histories")!;
    ui.node("workspace-site").value = "eu";
    const second = ui.node("workspace-site").listeners.get("change")!({ preventDefault() {} });
    const euRead = ui.calls.filter(call => call.params?.name === "get_histories").at(-1)!;
    expect(euRead.params?.arguments).toEqual({ instance: "eu", limit: 5, offset: 0 });
    ui.reply(euRead, { structuredContent: { ...historyResult, galaxy: eu } });
    await second;
    ui.reply(usRead, { structuredContent: { ...historyResult, galaxy: us, histories: [{ id: "old-us", name: "Stale US history", state: "ok" }] } });
    await first;
    expect(ui.node("histories").textContent).toContain("RNA analysis");
    expect(ui.node("histories").textContent).not.toContain("Stale US");
    const open = ui.node("histories").children[0]!.children[0]!.click();
    const contents = ui.calls.find(call => call.params?.name === "get_history_contents")!;
    expect(contents.params?.arguments?.instance).toBe("eu");
    ui.reply(contents, { structuredContent: { success: true, galaxy: us, data: items(1) } });
    await open;
    expect(ui.node("message").textContent).toContain("could not be loaded");
    expect(ui.calls.filter(call => call.method === "tools/call").every(call => call.params?.name?.startsWith("get_"))).toBe(true);
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({ galaxy: eu });
    ui.teardown();
    const selected = mount({ view: "workspace", connections: [eu], management_available: false,
      presentation: { view_id: "workspace-run" }, initial: { success: true, galaxy: eu,
        run: { kind: "workflow", id: "run-1", name: "RNA workflow", state: "completed", checked_at: new Date().toISOString() } },
    }, { initializeResult: { hostCapabilities: { serverTools: {}, updateModelContext: {} } } });
    await flush();
    expect(selected.node("workspace-site").value).toBe("eu");
    expect(selected.node("run-panel").hidden).toBe(false);
    expect(selected.node("manage-connections").hidden).toBe(true);
    expect(selected.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({
      view: "run_status", view_id: "workspace-run", galaxy: eu, kind: "workflow", run_id: "run-1", name: "RNA workflow",
    });
    selected.teardown();
  });
  it.each([false, true])("keeps the workspace preview and selection while toggling and paging its file list (standard host=%s)", async standardHost => {
    const us = { instance: "us", url: "https://usegalaxy.org" };
    const eu = { instance: "eu", url: "https://usegalaxy.eu" };
    const result = { view: "workspace", connections: [us, eu], initial: { success: true, galaxy: us,
      history_id: "private-history", data: items(5), pagination: { offset: 0, returned: 5, next_offset: 5, has_more: true } } };
    const ui = mount(standardHost ? undefined : result, {
      standardHost, initializeResult: { hostCapabilities: { serverTools: {}, updateModelContext: {} } },
      reply: rpc => ({ structuredContent: rpc.params?.name === "read_dataset_report"
        ? { galaxy: us, dataset_id: "private-dataset-0", name: "Result 0", extension: "pdf", preview_kind: "pdf",
          text: "Report text", source_sha256: "a".repeat(64), page: Number(rpc.params?.arguments?.page || 1), page_count: 2 }
        : rpc.params?.name === "get_history_contents"
          ? { success: true, galaxy: us, data: items(5, 5), pagination: { offset: 5, returned: 5, has_more: false } }
          : { ...historyResult, galaxy: eu },
        ...(rpc.params?.name === "read_dataset_report" ? { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] } : {}),
      }),
    });
    await flush();
    if (standardHost) ui.notify(result);
    expect(ui.node("galaxy-card").className).toBe("card workspace");
    expect(ui.node("histories").children).toHaveLength(5);
    await ui.node("histories").children[0]!.children[0]!.click();
    const image = ui.node("detail-body").querySelector("img");
    const raw = ui.node("detail-body").querySelector("details")!;
    raw.open = true;
    expect(ui.node("file-list-panel").hidden).toBe(true);
    expect(ui.node("workspace-file-list").textContent).toBe("Show file list");
    const callCount = ui.calls.filter(call => call.method === "tools/call").length;
    await ui.node("workspace-file-list").click();
    expect(ui.node("file-list-panel").hidden).toBe(false);
    expect(ui.node("workspace-file-list").textContent).toBe("Hide file list");
    expect(ui.node("workspace-file-list").getAttribute("aria-expanded")).toBe("true");
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(callCount);
    await ui.node("show-more").click(); // remote page
    expect(ui.node("histories").children).toHaveLength(10);
    await ui.node("show-less").click();
    expect(ui.node("histories").children).toHaveLength(5);
    await ui.node("show-more").click(); // cached page
    expect(ui.calls.filter(call => call.params?.name === "get_history_contents")).toHaveLength(1);
    expect(ui.node("histories").children[0]!.children[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(ui.node("dataset-detail").hidden).toBe(false);
    expect(ui.node("detail-body").querySelector("img")).toBe(image);
    expect(ui.node("detail-body").querySelector("details")).toBe(raw);
    expect(raw.open).toBe(true);
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({ view: "report", dataset_id: "private-dataset-0" });
    await ui.node("detail-body").children.at(-1)!.children[0]!.click();
    expect(ui.node("detail-message").textContent).toBe("Page 2 of 2");
    expect(ui.node("histories").children[0]!.children[0]!.getAttribute("aria-expanded")).toBe("true");
    await ui.node("workspace-file-list").click();
    expect(ui.node("file-list-panel").hidden).toBe(true);
    ui.node("workspace-site").value = "eu";
    await ui.node("workspace-site").listeners.get("change")!({ preventDefault() {} });
    expect(ui.node("dataset-detail").hidden).toBe(true);
    expect(ui.node("detail-body").children).toHaveLength(0);
    expect(ui.node("histories").textContent).toContain("RNA analysis");
    expect(ui.calls.filter(call => call.method === "tools/call").at(-1)?.params?.arguments?.instance).toBe("eu");
    ui.notify({ ...historyResult, galaxy: us, presentation: { view_id: "compact-card" } });
    expect(ui.node("galaxy-card").className).toBe("card");
    expect(ui.node("workspace-nav").hidden).toBe(true);
    expect(ui.node("workspace-file-list").hidden).toBe(true);
    ui.teardown();
  });

  it("loads remote histories five at a time, contracts locally and preserves source and navigation", async () => {
    const galaxy = { instance: "eu", url: "https://usegalaxy.eu" };
    const first = { status: "connected", galaxy, histories: items(5), pagination: { offset: 0, next_offset: 5, has_more: true } };
    const ui = mount(first, { reply: rpc => {
      const offset = Number(rpc.params?.arguments?.offset);
      if (rpc.params?.name === "get_histories") return { structuredContent: {
        status: "connected", galaxy, histories: items(offset === 5 ? 5 : 2, offset),
        pagination: { offset, next_offset: offset + 5, has_more: offset === 5 },
      } };
      return { structuredContent: { success: true, galaxy, data: [] } };
    } });
    await flush();
    expect(ui.node("histories").children).toHaveLength(5);
    expect(ui.node("show-less").hidden).toBe(true);
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(10);
    await ui.node("show-less").click();
    expect(ui.node("histories").children).toHaveLength(5);
    await ui.node("show-more").click(); // cached, no new network read
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(1);
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(12);
    expect(ui.node("show-more").hidden).toBe(true);
    await ui.node("histories").children[11]!.children[0]!.click();
    await ui.node("history-back").click();
    expect(ui.node("histories").children).toHaveLength(12);
    expect(ui.calls.filter(call => call.params?.name === "get_histories").map(call => call.params?.arguments)).toEqual([
      { instance: "eu", offset: 5, limit: 5 }, { instance: "eu", offset: 10, limit: 5 },
    ]);
    ui.notify(first);
    expect(ui.node("histories").children).toHaveLength(12);
  });

  it("retains histories after page failure and ignores a late page after navigation", async () => {
    const first = { status: "connected", histories: items(5), pagination: { offset: 0, next_offset: 5, has_more: true } };
    const ui = mount(first);
    await flush();
    const failed = ui.node("show-more").click();
    ui.reject(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { code: -32603 });
    await failed;
    expect(ui.node("histories").children).toHaveLength(5);
    expect(ui.node("message").textContent).toContain("unchanged");
    const more = ui.node("show-more").click();
    const pageCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    const opened = ui.node("histories").children[0]!.children[0]!.click();
    const historyCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    ui.reply(pageCall, { structuredContent: { ...first, histories: items(5, 5), pagination: { offset: 5, has_more: false } } });
    await more;
    ui.reply(historyCall, { structuredContent: { success: true, data: items(1) } });
    await opened;
    expect(ui.node("title").textContent).toBe("History contents");
    expect(ui.node("histories").children).toHaveLength(1);
    await ui.node("history-back").click();
    expect(ui.node("histories").children).toHaveLength(5);
  });

  it("binds two cards, paging, reports and restored cards to their own source", async () => {
    const sources = [{ instance: "us", url: "https://us.example.test" }, { instance: "eu", url: "https://eu.example.test" }];
    const cards = sources.map(galaxy => mount({ ...historyResult, galaxy }, { reply: rpc => ({ structuredContent: {
      galaxy, success: true, history_id: "private-history", data: items(5),
      ...(rpc.params?.name === "read_dataset_report" ? { name: "Result", text: galaxy.instance + " evidence" }
        : { pagination: { offset: 0, next_offset: 5, has_more: true } }),
    } }) }));
    await flush();
    for (const [index, ui] of cards.entries()) {
      expect(ui.node("instance").textContent).toContain(sources[index]!.instance);
      await ui.node("histories").children[0]!.children[0]!.click();
      await ui.node("show-more").click();
      await ui.node("histories").children[0]!.children[0]!.click();
      expect(ui.calls.filter(call => call.method === "tools/call").map(call => call.params?.name)).toEqual(["get_history_contents", "get_history_contents", "read_dataset_report"]);
      expect(ui.calls.filter(call => call.method === "tools/call").every(call => call.params?.arguments?.instance === sources[index]!.instance)).toBe(true);
      ui.cache(); ui.restore();
      expect(ui.node("instance").textContent).toContain(sources[index]!.instance);
    }
    const direct = mount({ success: true, galaxy: sources[1], view: "dataset", data: [{ ...items(1)[0], extension: "html" }] }, {
      reply: () => ({ structuredContent: { galaxy: sources[1], name: "Report", characters_returned: 13 }, _meta: { html: "<p>Report</p>" } }),
    });
    await flush();
    expect(direct.calls.find(call => call.params?.name === "get_dataset_html")?.params?.arguments?.instance).toBe("eu");
  });

  it("rejects cross-site responses and ignores an old in-flight response after a new view arrives", async () => {
    const us = { instance: "us", url: "https://us.example.test" };
    const eu = { instance: "eu", url: "https://eu.example.test" };
    const ui = mount({ ...historyResult, galaxy: us, presentation: { view_id: "us-view" } });
    await flush();
    const opening = ui.node("histories").children[0]!.children[0]!.click();
    const first = ui.calls.find(call => call.method === "tools/call")!;
    ui.reply(first, { structuredContent: { galaxy: eu, success: true, data: items(5) } });
    await opening;
    expect(ui.node("histories").children).toHaveLength(0);
    expect(ui.node("message").textContent).toContain("could not be loaded");
    ui.notify({ ...historyResult, galaxy: us, presentation: { view_id: "us-new" } });
    const old = ui.node("histories").children[0]!.children[0]!.click();
    const oldCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    ui.notify({ ...historyResult, galaxy: eu, presentation: { view_id: "eu-new" } });
    ui.reply(oldCall, { structuredContent: { galaxy: us, success: true, data: items(5) } });
    await old;
    expect(ui.node("instance").textContent).toBe("eu · eu.example.test");
    const current = ui.node("histories").children[0]!.children[0]!.click();
    const currentCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    expect(currentCall.params?.arguments?.instance).toBe("eu");
    ui.reply(currentCall, { structuredContent: { galaxy: eu, success: true, data: items(1) } });
    await current;
  });
  it.each([true, false])("keeps the matching history link through paging and uses optional host navigation=%s", async supported => {
    const url = "https://usegalaxy.eu/galaxy/histories/view?id=h1";
    const page = { success: true, data: items(10), history_id: "h1", history_url: url };
    const ui = mount(page, { initializeResult: { hostCapabilities: supported ? { openLinks: {} } : {} } });
    await flush();
    expect(ui.node("history-link").hidden).toBe(false);
    expect(ui.node("history-link").getAttribute("href")).toBe(url);
    await ui.node("show-more").click();
    await ui.node("show-less").click();
    expect(ui.node("history-link").getAttribute("href")).toBe(url);
    let prevented = false;
    const click = ui.node("history-link").click({ preventDefault: () => { prevented = true; } });
    const open = ui.calls.find(call => call.method === "ui/open-link");
    expect(prevented).toBe(supported);
    if (supported) {
      expect(open?.params).toEqual({ url });
      ui.reject(open!, { code: -32000, message: "Denied" });
      await click;
      expect(ui.node("history-link-note").hidden).toBe(false);
    } else expect(open).toBeUndefined();
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
    ui.notify({ ...historyResult, presentation: { view_id: "another-view" } });
    expect(ui.node("history-link").hidden).toBe(true);
    expect(ui.node("history-link").getAttribute("href")).toBeNull();
    expect(ui.node("history-link-note").hidden).toBe(true);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it("names the history in the title when opened straight on its contents", async () => {
    const ui = mount({ success: true, data: items(1), history_id: "h1", history_name: "RNA-seq: liver vs kidney" });
    await flush();
    expect(ui.node("title").textContent).toBe("RNA-seq: liver vs kidney");
    const unnamed = mount({ success: true, data: items(1), history_id: "h1" });
    await flush();
    expect(unnamed.node("title").textContent).toBe("History contents");
  });

  describe("uploading a local file", () => {
    const galaxy = { instance: "us", url: "https://usegalaxy.example" };
    const history = { success: true, data: items(1), history_id: "h1", history_name: "RNA-seq", galaxy };
    const upload = { url: "https://usegalaxy.example/api/upload/resumable_upload/0123456789abcdef", session_id: "0123456789abcdef", chunk_bytes: 10 };
    const file = (size: number) => ({ name: "counts.tsv", size, slice: (start: number, end: number) => ({ bytes: Math.min(size, end) - start }) });
    const tools = (ui: ReturnType<typeof mount>) => ui.calls.filter(call => call.method === "tools/call").map(call => [call.params?.name, call.params?.arguments]);
    const reply = (started: unknown = { success: true, galaxy, upload }) => (rpc: Rpc) => ({ structuredContent:
      rpc.params?.name === "start_file_upload" ? started
        : rpc.params?.name === "finish_file_upload" ? { success: true, galaxy, data: { outputs: [{ id: "d9" }], jobs: [{ id: "j9" }] } }
          : { ...history, data: items(2) } });
    const settle = async () => { for (let turn = 0; turn < 12; turn++) await flush(); };

    it("offers the upload only for a whole history bound to its site", async () => {
      const fetch = async () => undefined;
      const whole = mount(history, { fetch });
      await flush();
      expect(whole.node("upload-panel").hidden).toBe(false);
      for (const view of [{ ...history, galaxy: undefined }, { ...history, search: { complete: true } }, { ...history, view: "dataset" }, historyResult]) {
        const ui = mount(view, { fetch });
        await flush();
        expect(ui.node("upload-panel").hidden).toBe(true);
      }
      // A page that cannot make requests itself has nothing to offer.
      const noFetch = mount(history);
      await flush();
      expect(noFetch.node("upload-panel").hidden).toBe(true);
    });

    it("sends the bytes in order straight to Galaxy without credentials, then adds the file and reloads the history", async () => {
      const sent: Array<Record<string, unknown>> = [];
      const ui = mount(history, { reply: reply(), fetch: async (url, init) => {
        sent.push({ url, method: init.method, offset: init.headers["Upload-Offset"], bytes: init.body.bytes, credentials: init.credentials, type: init.headers["Content-Type"] });
        // The second reply reports its offset; the others leave the card to count.
        return { status: 204, ok: true, headers: { get: () => sent.length === 2 ? "20" : null } };
      } });
      await flush();
      await ui.choose(file(25));
      await settle();
      expect(sent).toEqual([0, 10, 20].map(offset => ({
        url: upload.url, method: "PATCH", offset: String(offset), bytes: offset === 20 ? 5 : 10, credentials: "omit", type: "application/offset+octet-stream",
      })));
      expect(tools(ui)).toEqual([
        ["start_file_upload", { historyId: "h1", fileName: "counts.tsv", size: 25, instance: "us" }],
        ["finish_file_upload", { historyId: "h1", fileName: "counts.tsv", sessionId: "0123456789abcdef", instance: "us" }],
        ["get_history_contents", { historyId: "h1", order: "newest", limit: 5, offset: 0, instance: "us" }],
      ]);
      expect(ui.node("upload-note").textContent).toContain("counts.tsv is in Galaxy");
      expect(ui.node("upload-note").hidden).toBe(false);
      expect(ui.node("histories").children).toHaveLength(2);
      expect(ui.node("upload-button").disabled).toBe(false);
      expect(ui.node("upload-cancel").hidden).toBe(true);
      expect(JSON.stringify(ui.calls)).not.toMatch(/api.?key|password|token/i);
    });

    it("resumes from what Galaxy has after an interruption", async () => {
      const sent: string[] = [];
      const ui = mount(history, { reply: reply(), fetch: async (_url, init) => {
        sent.push(init.method === "HEAD" ? "HEAD" : `PATCH ${init.headers["Upload-Offset"]}`);
        if (sent.length === 2) throw ui.networkError();
        return { status: init.method === "HEAD" ? 200 : 204, ok: true, headers: { get: () => init.method === "HEAD" ? "15" : null } };
      } });
      await flush();
      await ui.choose(file(25));
      await settle();
      expect(sent).toEqual(["PATCH 0", "PATCH 10", "HEAD", "PATCH 15"]);
      expect(tools(ui).map(([name]) => name)).toEqual(["start_file_upload", "finish_file_upload", "get_history_contents"]);
    });

    it("adds nothing when the host blocks Galaxy, Galaxy refuses, the address is elsewhere, or the file is empty", async () => {
      const blocked = mount(history, { reply: reply(), fetch: async () => { throw blocked.networkError(); } });
      const refused = mount(history, { reply: reply(), fetch: async () => ({ status: 403, ok: false, headers: { get: () => null } }) });
      const elsewhere = mount(history, { reply: reply({ success: true, galaxy, upload: { ...upload, url: "https://attacker.example/api/upload/resumable_upload/0123456789abcdef" } }),
        fetch: async () => { throw new Error("must not be contacted"); } });
      const empty = mount(history, { reply: reply(), fetch: async () => { throw new Error("must not be contacted"); } });
      for (const [ui, size, text] of [
        [blocked, 25, "did not let the card reach Galaxy"], [refused, 25, "Galaxy refused the upload (HTTP 403). Nothing was added"],
        [elsewhere, 25, "another site. Nothing was added"], [empty, 0, "This file is empty"],
      ] as const) {
        await flush();
        await ui.choose(file(size));
        await settle();
        expect(ui.node("upload-note").textContent).toContain(text);
        expect(tools(ui).map(([name]) => name)).not.toContain("finish_file_upload");
        expect(ui.node("upload-button").disabled).toBe(false);
      }
      expect(tools(empty)).toEqual([]);
    });

    it("reports an unanswered start as one clear sentence", async () => {
      const ui = mount(history, { fetch: async () => { throw new Error("must not be contacted"); } });
      await flush();
      void ui.choose(file(25));
      await settle();
      ui.expire(45000);
      await settle();
      expect(ui.node("upload-note").textContent).toBe("Galaxy view request timed out. Nothing was added to the history.");
      expect(ui.node("upload-button").disabled).toBe(false);
    });

    it("stops sending when cancelled", async () => {
      const sent: string[] = [];
      const ui = mount(history, { reply: reply(), fetch: (_url, init) => {
        sent.push(init.headers["Upload-Offset"] ?? "");
        return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(ui.networkError())));
      } });
      await flush();
      void ui.choose(file(25));
      await settle();
      expect(ui.node("upload-cancel").hidden).toBe(false);
      await ui.node("upload-cancel").click();
      await settle();
      expect(sent).toEqual(["0"]);
      expect(ui.node("upload-note").textContent).toBe("Upload cancelled. Nothing was added to the history.");
      expect(tools(ui).map(([name]) => name)).toEqual(["start_file_upload"]);
    });
  });

  it.each([undefined, "javascript:alert(1)", "https://key:secret@example.test/histories/view?id=h1", "https://example.test/histories/view?id=other"])("does not expose a missing, unsafe or mismatched history link: %s", async history_url => {
    const ui = mount({ success: true, data: items(1), history_id: "h1", history_url });
    await flush();
    expect(ui.node("history-link").hidden).toBe(true);
    expect(ui.node("history-link").getAttribute("href")).toBeNull();
  });

  it("expands and collapses five at a time, keeping cached rows and keyboard focus", async () => {
    const ui = mount({ success: true, data: items(12) });
    await flush();
    expect(ui.node("show-less").hidden).toBe(true);
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(10);
    expect(ui.node("show-less").hidden).toBe(false);
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(12);
    expect(ui.node("show-more").hidden).toBe(true);
    await ui.node("show-less").click();
    expect(ui.node("histories").children).toHaveLength(7);
    await ui.node("show-less").click();
    expect(ui.node("histories").children).toHaveLength(5);
    expect(ui.node("show-less").hidden).toBe(true);
    expect(ui.node("show-more").focused).toBe(true);
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(10);
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
  });

  it("preserves search filters and collapsed rows when an older page arrives", async () => {
    const page = { success: true, data: items(10), order: "oldest", history_id: "h1", filters: { query: "result", extension: "txt", deleted: false, visible: true }, pagination: { offset: 0, returned: 10, has_more: true, next_offset: 140 } };
    const ui = mount(page);
    await flush();
    await ui.node("show-more").click();
    const more = ui.node("show-more").click();
    const call = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    // The next page keeps the order and the filters of the listing the assistant asked for.
    expect(call.params?.arguments).toEqual({ ...page.filters, order: "oldest", historyId: "h1", limit: 5, offset: 140 });
    await ui.node("show-less").click();
    ui.reply(call, { structuredContent: { ...page, data: items(5, 10) } });
    await more;
    expect(ui.node("histories").children).toHaveLength(5);
    expect(ui.node("show-more").disabled).toBe(false);
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(10);
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(1);
  });

  it.each([true, false])("opens a selected report directly with context support=%s, without listing a history", async supported => {
    const ui = mount(undefined, {
      standardHost: true, initialize: false,
      reply: () => ({ structuredContent: { name: "HTML result", characters_returned: 18 }, _meta: { html: "<p>Test report</p>" } }),
    });
    ui.notify({ success: true, view: "dataset", presentation: { view_id: "current-view" }, data: [{ ...items(1)[0], extension: "html" }] });
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
    ui.reply(ui.calls.find(call => call.method === "ui/initialize")!, { hostCapabilities: { serverTools: {}, ...(supported && { updateModelContext: {} }) } });
    await flush();
    expect(ui.calls.filter(call => call.method === "tools/call").map(call => call.params?.name)).toEqual(["get_dataset_html"]);
    expect(ui.node("dataset-detail").hidden).toBe(false);
    expect(ui.node("detail-title").textContent).toBe("HTML result");
    const updates = ui.calls.filter(call => call.method === "ui/update-model-context");
    if (supported) {
      expect(updates.at(-1)?.params?.structuredContent).toMatchObject({ view_id: "current-view", dataset_id: "private-dataset-0", report_status: "content_loaded", display_verified: false, report_content_in_feedback: false });
      expect(updates.at(-1)?.params?.structuredContent).not.toHaveProperty("model_has_report_content");
      expect(JSON.stringify(updates)).not.toContain("<p>");
    } else expect(updates).toHaveLength(0);
    await ui.node("detail-close").click();
    expect(ui.node("histories").children).toHaveLength(1);
    expect(ui.node("show-less").hidden).toBe(true);
    expect(ui.node("show-more").hidden).toBe(true);
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(1);
  });

  it("correlates a new host view without accepting old card replays or late report content", async () => {
    const ui = mount(undefined, { initializeResult: { hostCapabilities: { serverTools: {}, updateModelContext: {} } } });
    await flush();
    const result = (id: string) => ({ success: true, view: "dataset", presentation: { view_id: id }, data: [{ ...items(1)[0], extension: "html" }] });
    ui.notify(result("old-view"));
    const oldCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    ui.notify(result("current-view"));
    const currentCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    expect(currentCall.id).not.toBe(oldCall.id);
    ui.notify(result("old-view"));
    ui.reply(oldCall, { structuredContent: { name: "Old content" }, _meta: { html: "<p>Old</p>" } });
    await flush();
    expect(ui.node("detail-title").textContent).not.toBe("Old content");
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({ view_id: "current-view", report_status: "loading", display_verified: false });
    ui.reply(currentCall, { structuredContent: { name: "Current content" }, _meta: { html: "<p>Current</p>" } });
    await flush();
    expect(ui.node("detail-title").textContent).toBe("Current content");
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({ view_id: "current-view", report_status: "content_loaded", display_verified: false });
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(2);
    await ui.node("detail-close").click();
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({ view_id: "current-view", report_status: "not_open", display_verified: false });
  });

  it.each([
    ["txt", "error"], ["html", "error"], ["html", "timeout"], ["html", "missing_html"],
  ])("reports %s load failure (%s) without claiming display, and recovers on retry", async (extension, failure) => {
    const ui = mount({ success: true, view: "dataset", data: [{ ...items(1)[0], extension }] }, {
      initializeResult: { hostCapabilities: { serverTools: {}, updateModelContext: {} } },
    });
    await flush();
    const call = ui.calls.find(call => call.method === "tools/call")!;
    expect(call.params?.name).toBe(extension === "html" ? "get_dataset_html" : "read_dataset_report");
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({ report_status: "loading", display_verified: false });
    if (failure === "timeout") ui.expire(45000);
    else ui.reply(call, failure === "error" ? { isError: true } : { structuredContent: { name: "HTML result" } });
    await flush();
    expect(ui.node("detail-message").textContent).toMatch(/could not be loaded|Full-file preview is unavailable/);
    expect(ui.node("detail-body").textContent).toContain("not the full file");
    const metadataRead = ui.calls.find(call => call.params?.name === "get_dataset_details");
    if (metadataRead) ui.reply(metadataRead, { isError: true });
    await flush();
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").at(-1)?.params?.structuredContent).toMatchObject({ report_status: "load_failed", display_verified: false });
    await ui.node("detail-close").click();
    const button = ui.node("histories").children[0]!.children[0]!;
    expect(button.disabled).toBe(false);
    const retry = button.click();
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { name: "Recovered report", text: "Report text" }, _meta: { html: "<p>Report text</p>" } });
    await retry;
    expect(ui.node("detail-title").textContent).toBe("Recovered report");
    expect(ui.node("detail-message").textContent).not.toContain("could not load");
    expect(ui.calls.filter(call => call.method === "ui/update-model-context").some(call => (call.params?.structuredContent as { display_verified?: boolean })?.display_verified === true)).toBe(false);
  });

  it("serves only the current UI resource and reveals every returned item without inventing a total", async () => {
    expect([...resources.keys()]).toEqual([HISTORY_SUMMARY_URI]);
    expect(html).toContain('alt="Galaxy" width="597" height="451" src="data:image/png;base64,');
    const ui = mount({ success: true, data: items(25) });
    await flush();
    expect(ui.node("histories").children).toHaveLength(5);
    expect(ui.node("message").textContent).toContain("5 of 25 loaded");
    expect(ui.node("histories").textContent).not.toContain("private-dataset");
    for (let page = 0; page < 4; page++) await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(25);
    expect(ui.node("show-more").hidden).toBe(true);
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
    const histories = mount({ status: "connected", histories: items(25) }, { reply: () => ({ structuredContent: { success: true, data: [] } }) });
    await flush();
    expect(histories.node("message").textContent).toContain("5 of 25 loaded histories");
    expect(histories.node("show-less").hidden).toBe(true);
    for (let page = 0; page < 4; page++) await histories.node("show-more").click();
    await histories.node("histories").children[24]!.children[0]!.click();
    await histories.node("history-back").click();
    expect(histories.node("histories").children).toHaveLength(25);
    for (let page = 0; page < 4; page++) await histories.node("show-less").click();
    expect(histories.node("histories").children).toHaveLength(5);
    expect(histories.node("show-less").hidden).toBe(true);
    expect(histories.node("show-more").textContent).toBe("Load more");
  });

  it("opens a one-time connection manager without leaking the card's Galaxy instance", async () => {
    const ticket = "t".repeat(43);
    const url = `https://mcp.example.org/connections/${ticket}`;
    const ui = mount({ ...historyResult, galaxy: { instance: "eu", url: "https://usegalaxy.eu" } }, {
      initializeResult: { hostCapabilities: { serverTools: {}, openLinks: {} } },
      reply: () => ({ structuredContent: { url, expires_in: 300 } }),
    });
    await flush();
    expect(ui.node("manage-connections").hidden).toBe(false);
    const opening = ui.node("manage-connections").click();
    await flush();
    expect(ui.calls.find(call => call.params?.name === "get_connection_management_link")?.params).toEqual({
      name: "get_connection_management_link", arguments: {},
    });
    const openLink = ui.calls.find(call => call.method === "ui/open-link")!;
    expect(openLink.params).toEqual({ url });
    ui.reply(openLink, {});
    await opening;
    expect(ui.node("manage-connections").disabled).toBe(false);
    expect(ui.pending()).toBe(0);
  });

  it("does not open a connection-management link on another origin", async () => {
    const url = `https://auth.example.org/connections/${"t".repeat(43)}`;
    const ui = mount(historyResult, {
      initializeResult: { hostCapabilities: { serverTools: {}, openLinks: {} } },
      reply: () => ({ structuredContent: { url, expires_in: 300 } }),
    });
    await flush();
    await ui.node("manage-connections").click();
    await flush();
    expect(ui.calls.some(call => call.method === "ui/open-link")).toBe(false);
    expect(ui.node("manage-connections").disabled).toBe(false);
  });

  it("shows an item once when a new one moved the next newest-first page down", async () => {
    const dataset = (index: number) => ({ ...items(1, index)[0]!, history_content_type: "dataset" });
    // Galaxy numbers datasets and collections separately, so the two kinds can share an id.
    const collection = { id: dataset(4).id, name: "Paired reads", state: "ok", history_content_type: "dataset_collection" };
    const first = { success: true, order: "newest", history_id: "h1", data: [0, 1, 2, 3, 4].map(dataset), pagination: { offset: 0, returned: 5, has_more: true, next_offset: 5 } };
    const ui = mount(first, { reply: () => ({ structuredContent: { ...first, data: [dataset(4), collection, dataset(5)], pagination: { offset: 5, returned: 3, has_more: false } } }) });
    await flush();
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(7);
    expect(ui.node("histories").textContent).toContain("Paired reads");
    expect(ui.node("histories").textContent.match(/Result 4/g)).toHaveLength(1);
  });

  it("navigates a history, appends a remote page, and ignores host replay during browsing", async () => {
    const ui = mount(historyResult, { reply: rpc => {
      const offset = Number(rpc.params?.arguments?.offset);
      return { structuredContent: { success: true, data: items(offset ? 1 : 5, offset), history_id: "private-history", pagination: { offset, limit: 5, returned: offset ? 1 : 5, has_more: !offset, next_offset: 5 } } };
    } });
    await flush();
    await ui.node("histories").children[0]!.children[0]!.click();
    expect(ui.node("breadcrumbs").hidden).toBe(false);
    expect(ui.node("history-name").textContent).toBe("RNA analysis");
    expect(ui.node("message").textContent).toContain("more available");
    ui.notify(historyResult);
    ui.globals({ toolOutput: historyResult, theme: "dark" });
    expect(ui.node("title").textContent).toBe("History contents");
    expect(ui.root.style.colorScheme).toBe("dark");
    ui.root.getBoundingClientRect = () => ({ height: 650 });
    ui.resize();
    expect(ui.calls.at(-1)?.method).toBe("ui/notifications/size-changed");
    await ui.node("show-more").click();
    expect(ui.calls.filter(call => call.method === "tools/call").map(call => call.params?.arguments)).toEqual([
      { historyId: "private-history", order: "newest", limit: 5, offset: 0 }, { historyId: "private-history", order: "newest", limit: 5, offset: 5 },
    ]);
    expect(ui.node("histories").children).toHaveLength(6);
    expect(ui.node("show-more").hidden).toBe(true);
    await ui.node("history-back").click();
    expect(ui.node("histories").textContent).toContain("RNA analysis");
    expect(ui.pending()).toBe(0);
    expect(ui.timers.size).toBe(0);
  });

  it("keeps prior results when pagination fails and permits retry", async () => {
    const ui = mount({ success: true, data: items(5), history_id: "private-history", pagination: { offset: 0, returned: 5, has_more: true, next_offset: 5 } }, { reply: () => ({ isError: true }) });
    await flush();
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(5);
    expect(ui.node("show-more").textContent).toBe("Retry loading more");
    expect(ui.node("show-more").disabled).toBe(false);
  });

  it.each(["success", "error", "timeout"])("keeps the selected report open when pending pagination ends with %s", async outcome => {
    const page = { success: true, data: items(5), history_id: "private-history", pagination: { offset: 0, returned: 5, has_more: true, next_offset: 5 } };
    const ui = mount(page);
    await flush();
    const more = ui.node("show-more").click();
    const pageCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    const report = ui.node("histories").children[0]!.children[0]!.click();
    const reportCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    const reportResult = { structuredContent: { name: "Selected report", text: "Selected result" } };
    if (outcome !== "success") {
      ui.reply(reportCall, reportResult);
      await report;
    }
    if (outcome === "timeout") ui.expire(45000);
    else ui.reply(pageCall, outcome === "error" ? { isError: true } : { structuredContent: { ...page, data: items(1, 5), pagination: { has_more: false } } });
    await more;
    expect(ui.node("dataset-detail").hidden).toBe(false);
    if (outcome === "success") {
      ui.reply(reportCall, reportResult);
      await report;
    }
    expect(ui.node("detail-body").textContent).toContain("Selected result");
    await ui.node("detail-close").click();
    expect(ui.node("histories").children).toHaveLength(5);
    expect(ui.node("show-more").disabled).toBe(false);
    expect(ui.node("show-more").textContent).toBe("Load more");
    const retry = ui.node("show-more").click();
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { ...page, data: items(1, 5), pagination: { has_more: false } } });
    await retry;
    expect(ui.node("histories").children).toHaveLength(6);
  });

  it("ignores an older report reply after returning and selecting another report", async () => {
    const ui = mount({ success: true, data: items(2) });
    await flush();
    const first = ui.node("histories").children[0]!.children[0]!.click();
    const firstCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    await ui.node("detail-close").click();
    const second = ui.node("histories").children[1]!.children[0]!.click();
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { name: "Second report", text: "Current result" } });
    await second;
    ui.reply(firstCall, { structuredContent: { name: "First report", text: "Stale result" } });
    await first;
    expect(ui.node("detail-title").textContent).toBe("Second report");
    expect(ui.node("detail-body").textContent).toContain("Current result");
    expect(ui.node("detail-body").textContent).not.toContain("Stale result");
  });

  it.each([true, false])("gates remote browsing for serverTools=%s regardless of initialization order, while keeping local expansion", async supported => {
    for (const snapshotFirst of [true, false]) {
      for (const contents of [true, false]) {
        const snapshot = contents
          ? { success: true, data: items(25), history_id: "private-history", pagination: { has_more: true, next_offset: 25 } }
          : { status: "connected", histories: items(25) };
        const ui = mount(undefined, { standardHost: true, initialize: false });
        if (snapshotFirst) {
          ui.notify(snapshot);
          expect(ui.node("histories").children[0]!.children[0]!.disabled).toBe(true);
          await ui.node("histories").children[0]!.children[0]!.click();
          expect(ui.node("histories").hidden).toBe(false);
          for (let page = 0; page < 4; page++) await ui.node("show-more").click();
          expect(ui.node("histories").children).toHaveLength(25);
        }
        ui.reply(ui.calls.find(call => call.method === "ui/initialize")!, { hostCapabilities: supported ? { serverTools: {} } : {} });
        await flush();
        if (!snapshotFirst) ui.notify(snapshot);
        expect(ui.node("histories").children[0]!.children[0]!.disabled).toBe(!supported);
        if (!supported) {
          await ui.node("histories").children[0]!.children[0]!.click();
          expect(ui.node("histories").hidden).toBe(false);
          expect(ui.node("message").textContent).toContain("does not support browsing");
        }
        if (!snapshotFirst) {
          expect(ui.node("show-more").disabled).toBe(false);
          for (let page = 0; page < 4; page++) await ui.node("show-more").click();
        }
        expect(ui.node("histories").children).toHaveLength(25);
        if (contents) expect(ui.node("show-more").disabled).toBe(!supported);
        else expect(ui.node("show-more").hidden).toBe(true);
        expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
      }
    }
  });

  it("does not replace Histories with a late response after Back", async () => {
    const ui = mount(historyResult);
    await flush();
    const loading = ui.node("histories").children[0]!.children[0]!.click();
    await ui.node("history-back").click();
    ui.reply(ui.calls.find(call => call.method === "tools/call")!, { structuredContent: { success: true, data: items(1) } });
    await loading;
    expect(ui.node("title").textContent).toBe("Galaxy histories");
    expect(ui.node("histories").textContent).toContain("RNA analysis");
  });

  it("times out absent host replies, restores controls, and clears pending work on close", async () => {
    const ui = mount({ success: true, data: items(1) });
    await flush();
    const button = ui.node("histories").children[0]!.children[0]!;
    const loading = button.click();
    expect(ui.node("histories").hidden).toBe(true);
    ui.expire(45000);
    await loading;
    expect(ui.node("detail-message").textContent).toContain("try again");
    expect(ui.node("dataset-detail").attrs.has("aria-busy")).toBe(false);
    expect(button.disabled).toBe(false);
    expect(ui.pending()).toBe(0);
    await ui.node("detail-close").click();
    expect(ui.node("histories").hidden).toBe(false);
    expect(button.focused).toBe(true);
    const next = button.click();
    ui.close();
    await next;
    expect(ui.pending()).toBe(0);
    expect(ui.timers.size).toBe(0);
    const noHost = mount(undefined, { initialize: false });
    noHost.expire(15000);
    await flush();
    expect(noHost.node("badge").textContent).toBe("Unavailable");
    expect(noHost.pending()).toBe(0);
  });

  it("shows real text and truncation with keyboard scrolling, then returns to results", async () => {
    const text = "gene\tsample\nTP53\t42";
    const ui = mount({ success: true, data: items(1) }, { reply: () => ({ structuredContent: { name: "Expression", text, truncated: true } }) });
    await flush();
    await ui.node("histories").children[0]!.children[0]!.click();
    const raw = ui.node("detail-body").children[0]!.children[1]!;
    expect(raw.textContent).toBe(text);
    expect(raw.tabIndex).toBe(0);
    expect(ui.node("detail-message").textContent).toContain("truncated");
    expect(ui.node("detail-close").focused).toBe(true);
    await ui.node("detail-close").click();
    expect(ui.node("dataset-detail").hidden).toBe(true);
  });

  it("rebuilds static report nodes without frames, executable markup, source attributes or external requests", () => {
    const anchor = new Element("A");
    anchor.setAttribute("href", "#statistics");
    anchor.setAttribute("target", "_top");
    anchor.setAttribute("onclick", "alert(1)");
    const use = new Element("use");
    use.setAttribute("xlink:href", "#plot-symbol");
    use.setAttribute("xml:base", "https://example.test/");
    const external = new Element("A");
    external.setAttribute("href", "https://example.test");
    const unsafe = new Element("A");
    unsafe.setAttribute("href", "javascript:alert(1)");
    const image = new Element("IMG");
    image.setAttribute("src", "https://example.test/image.png");
    image.setAttribute("alt", "External plot omitted");
    const raster = new Element("IMG");
    raster.setAttribute("src", "data:image/png;base64,aGVsbG8=");
    raster.setAttribute("onerror", "alert(1)");
    const svgImage = new Element("IMG");
    svgImage.setAttribute("src", "data:image/svg+xml;base64,aGVsbG8=");
    const scriptElement = new Element("SCRIPT");
    scriptElement.textContent = "unsafe script";
    const style = new Element("STYLE");
    style.textContent = "body {display:none}";
    const svg = new Element("SVG");
    svg.namespaceURI = "http://www.w3.org/2000/svg";
    svg.append(use);
    const table = new Element("TABLE");
    table.setAttribute("id", "detail-body");
    table.setAttribute("style", "position:fixed");
    const row = new Element("TR");
    const cell = new Element("TD");
    cell.textContent = "42 reads";
    cell.setAttribute("colspan", "2");
    cell.setAttribute("rowspan", "999999999");
    row.append(cell); table.append(row);
    const ui = mount(undefined, { elements: [anchor, external, unsafe, image, raster, svgImage, scriptElement, style, svg, table] });
    const { preview, limited } = ui.preview();
    expect(limited).toBe(false);
    expect(preview.textContent).toBe("External plot omitted42 reads");
    expect(preview.children.map(node => node.tagName)).toEqual(["#text", "IMG", "TABLE"]);
    expect(preview.querySelector("img")?.attrs).toEqual(new Map([["src", "data:image/png;base64,aGVsbG8="], ["alt", "Report image"]]));
    expect(preview.querySelector("table")?.attrs.size).toBe(0);
    expect(preview.querySelector("td")?.attrs).toEqual(new Map([["colspan", "2"]]));
    expect(table.attrs.get("id")).toBe("detail-body"); // Source nodes were not adopted or mutated.
    expect(html).not.toMatch(/createElement\("iframe"\)|\.srcdoc|\.innerHTML\s*=/);
  });

  it.each([true, false])("shows a static report and the original Galaxy link with host navigation=%s", async supported => {
    const reportText = "Quality summary\nReads\t42\n";
    const ui = mount(undefined, {
      standardHost: true,
      initializeResult: { hostCapabilities: { serverTools: {}, ...(supported ? { openLinks: {} } : {}) } },
      htmlText: reportText,
      reply: () => ({ structuredContent: { name: "Quality report", dataset_id: "private-dataset-0", url: "https://usegalaxy.eu/galaxy/datasets/private-dataset-0/display" }, _meta: { html: "<h1>Quality summary</h1><table><tr><th>Reads</th><td>42</td></tr></table>" } }),
    });
    await flush();
    ui.notify({ success: true, data: [{ ...items(1)[0], extension: "html" }] });
    await ui.node("histories").children[0]!.children[0]!.click();
    expect(ui.calls.filter(call => call.method === "tools/call").map(call => call.params)).toEqual([
      { name: "get_dataset_html", arguments: { datasetId: "private-dataset-0" } },
    ]);
    const body = ui.node("detail-body");
    expect(body.children[1]!.children[0]!.textContent).toBe(reportText);
    expect(body.children[1]!.tabIndex).toBe(0);
    expect(body.querySelector("iframe")).toBeUndefined();
    expect(ui.node("detail-message").textContent).toContain("Static report preview");
    expect(ui.node("report-link").hidden).toBe(false);
    let prevented = false;
    const opening = ui.node("report-link").click({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(supported);
    if (supported) {
      const request = ui.calls.find(call => call.method === "ui/open-link")!;
      expect(request.params).toEqual({ url: "https://usegalaxy.eu/galaxy/datasets/private-dataset-0/display" });
      ui.reject(request, { message: "Denied" });
      await opening;
      expect(ui.node("report-link-note").hidden).toBe(false);
    }
    await ui.node("detail-close").click();
    expect(ui.node("report-link").hidden).toBe(true);
    expect(ui.node("report-link").getAttribute("href")).toBeNull();
    expect(ui.pending()).toBe(0);
  });

  it.each([undefined, "javascript:alert(1)", "https://key:secret@example.test/datasets/private-dataset-0/display", "https://example.test/datasets/other/display", "https://example.test/datasets/private-dataset-0/display?key=secret"])("rejects unsafe, credential-bearing or mismatched original-report links: %s", async url => {
    const ui = mount({ success: true, data: [{ ...items(1)[0], extension: "html" }] }, {
      reply: () => ({ structuredContent: { dataset_id: "private-dataset-0", url }, _meta: { html: "<p>Report</p>" } }),
    });
    await flush();
    await ui.node("histories").children[0]!.children[0]!.click();
    expect(ui.node("report-link").hidden).toBe(true);
    expect(ui.node("report-link").getAttribute("href")).toBeNull();
  });

  it("bounds deeply nested and oversized report previews", () => {
    const root = new Element("DIV");
    let next = root;
    for (let i = 0; i < 70; i++) { const child = new Element("DIV"); next.append(child); next = child; }
    next.textContent = "Past depth limit";
    const deep = mount(undefined, { elements: [root] }).preview();
    expect(deep.limited).toBe(true);
    expect(deep.preview.textContent).not.toContain("Past depth limit");
    const wide = mount(undefined, { elements: Array.from({ length: 10002 }, () => new Element("BR")) }).preview();
    expect(wide.limited).toBe(true);
  });
});

const running = {
  kind: "tool", id: "private-run", name: "Read quality check", state: "running",
  checked_at: "2026-09-05T12:00:00.000Z", history_id: "private-history",
  jobs: { completed: 1, failed: 0, running: 1, queued: 2, other: 0, total: 4 },
};

describe("run status card", () => {
  it("keeps auto/manual refresh and result browsing on the original site, rejecting a different site's status", async () => {
    const galaxy = { instance: "eu", url: "https://eu.example.test" };
    const ui = mount({ success: true, galaxy, run: running });
    await flush();
    ui.intersect(true); ui.expire(15000);
    const first = ui.calls.find(call => call.params?.name === "get_run_status")!;
    expect(first.params?.arguments?.instance).toBe("eu");
    ui.reply(first, { structuredContent: { success: true, galaxy: { instance: "us", url: "https://us.example.test" }, run: { ...running, state: "completed" } } });
    await flush();
    expect(ui.node("badge").textContent).toBe("Unconfirmed");
    expect(ui.node("run-warning").textContent).toContain("Last known status: Running");
    const manual = ui.node("run-refresh").click();
    const second = ui.calls.filter(call => call.params?.name === "get_run_status").at(-1)!;
    expect(second.params?.arguments?.instance).toBe("eu");
    ui.reply(second, { structuredContent: { success: true, galaxy, run: { ...running, state: "completed" } } });
    await manual;
    const browsing = ui.node("run-results").click();
    const contents = ui.calls.find(call => call.params?.name === "get_history_contents")!;
    expect(contents.params?.arguments?.instance).toBe("eu");
    ui.reply(contents, { structuredContent: { success: true, galaxy, data: items(1) } });
    await browsing;
    ui.cache(); ui.restore();
    expect(ui.node("instance").textContent).toBe("eu · eu.example.test");
  });
  it("refreshes a snapshot once without submitting jobs, then opens the existing result browser", async () => {
    const completed = { ...running, state: "completed", checked_at: "2026-09-05T12:05:00.000Z", jobs: { ...running.jobs, completed: 4, running: 0, queued: 0 } };
    const ui = mount({ success: true, run: running });
    await flush();
    expect(ui.node("title").textContent).toBe("Read quality check");
    expect(ui.node("badge").textContent).toBe("Running");
    expect(ui.node("run-jobs").textContent).toContain("Completed jobs1");
    expect(ui.node("run-jobs").textContent).not.toContain("private-");
    const firstChecked = ui.node("run-checked").textContent;
    const refresh = ui.node("run-refresh").click();
    await ui.node("run-refresh").click();
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(1);
    expect(ui.node("run-refresh").disabled).toBe(true);
    expect(ui.node("run-checked").textContent).toBe(firstChecked);
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { success: true, run: completed } });
    await refresh;
    expect(ui.node("badge").textContent).toBe("Completed");
    expect(ui.node("run-checked").textContent).not.toBe(firstChecked);
    expect(ui.node("run-refresh").disabled).toBe(false);

    const results = ui.node("run-results").click();
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { success: true, data: items(1) } });
    await results;
    expect(ui.node("title").textContent).toBe("History results");
    expect(ui.node("run-panel").hidden).toBe(true);
    expect(ui.node("history-back").textContent).toBe("‹ Run status");
    const report = ui.node("histories").children[0]!.children[0]!.click();
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { name: "Report", text: "Quality result" } });
    await report;
    expect(ui.node("detail-body").textContent).toContain("Quality result");
    await ui.node("detail-close").click();
    await ui.node("history-back").click();
    expect(ui.node("run-panel").hidden).toBe(false);
    expect(ui.node("run-results").focused).toBe(true);
    expect(ui.node("badge").textContent).toBe("Completed");
    expect(ui.node("run-results-note").textContent).toContain("other runs");
    expect(ui.calls.filter(call => call.method === "tools/call").map(call => call.params)).toEqual([
      { name: "get_run_status", arguments: { kind: "tool", runId: "private-run" } },
      { name: "get_history_contents", arguments: { historyId: "private-history", order: "newest", limit: 5, offset: 0 } },
      { name: "read_dataset_report", arguments: { datasetId: "private-dataset-0", page: 1, offset: 0, includeImage: true } },
    ]);
  });

  it("keeps the last known snapshot and checked time after an error or timeout, with a working retry", async () => {
    const ui = mount({ success: true, run: running });
    await flush();
    const checked = ui.node("run-checked").textContent;
    const failed = ui.node("run-refresh").click();
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { isError: true, structuredContent: { success: false, run: { ...running, state: "unknown", checked_at: "2026-09-05T12:10:00.000Z" } } });
    await failed;
    expect(ui.node("badge").textContent).toBe("Unconfirmed");
    expect(ui.node("run-warning").textContent).toContain("Last known status: Running");
    expect(ui.node("run-checked").textContent).toBe(checked);
    expect(ui.node("run-jobs").textContent).toContain("Running jobs1");
    expect(ui.node("run-refresh").textContent).toBe("Retry status check");
    const timeout = ui.node("run-refresh").click();
    ui.expire(45000);
    await timeout;
    expect(ui.node("run-checked").textContent).toBe(checked);
    expect(ui.node("run-refresh").disabled).toBe(false);
    const retry = ui.node("run-refresh").click();
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { success: true, run: { ...running, state: "failed", message: "A job could not read its input." } } });
    await retry;
    expect(ui.node("badge").textContent).toBe("Failed");
    expect(ui.node("message").textContent).toBe("A job could not read its input.");
    expect(ui.node("run-warning").hidden).toBe(true);
    expect(ui.node("run-results").disabled).toBe(false);
    expect(ui.pending()).toBe(0);
  });

  it("does not replace the result browser with late status or history responses", async () => {
    const ui = mount({ success: true, run: running });
    await flush();
    const refresh = ui.node("run-refresh").click();
    const statusCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    const results = ui.node("run-results").click();
    const historyCall = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    ui.reply(statusCall, { structuredContent: { success: true, run: { ...running, state: "completed" } } });
    await refresh;
    expect(ui.node("title").textContent).toBe("History results");
    await ui.node("history-back").click();
    ui.reply(historyCall, { structuredContent: { success: true, data: items(1) } });
    await results;
    expect(ui.node("badge").textContent).toBe("Running");
    expect(ui.node("run-refresh").disabled).toBe(false);
    ui.notify({ success: true, run: { ...running, state: "completed" } });
    expect(ui.node("badge").textContent).toBe("Running");
  });

  it("uses human defaults and disables unavailable actions without inventing checks or results", async () => {
    const ui = mount({ success: false, run: { kind: "workflow", state: "unknown" } });
    await flush();
    expect(ui.node("title").textContent).toBe("Galaxy workflow");
    expect(ui.node("run-refresh").disabled).toBe(true);
    expect(ui.node("run-results").disabled).toBe(true);
    expect(ui.node("run-checked").textContent).toBe("No confirmed status check yet.");
    expect(ui.node("run-jobs").hidden).toBe(true);
    await ui.node("run-refresh").click();
    await ui.node("run-results").click();
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
    expect(script).not.toMatch(/name: "(?:run_tool|invoke_workflow|cancel_workflow_invocation)"/);
    const named = mount({ success: true, run: { ...running, name: "<img src=x onerror=alert(1)>" } });
    expect(named.node("title").textContent).toBe("<img src=x onerror=alert(1)>");
    expect(named.node("title").children).toHaveLength(0);
    const offline = mount({ success: true, run: running }, { initialize: false });
    const checked = offline.node("run-checked").textContent;
    offline.expire(15000);
    await flush();
    expect(offline.node("badge").textContent).toBe("Unconfirmed");
    expect(offline.node("run-checked").textContent).toBe(checked);
    expect(offline.node("run-warning").textContent).toContain("Last known status: Running");
    const skipped = mount({ success: true, run: { ...running, state: "empty", jobs: { other: 1, total: 1 } } });
    expect(skipped.node("badge").textContent).toBe("No analysis ran");
    expect(skipped.node("run-jobs").textContent).toContain("Total jobs1");
  });
});

const statusCalls = (ui: ReturnType<typeof mount>) => ui.calls.filter(call => call.method === "tools/call" && call.params?.name === "get_run_status");
const pollTimers = (ui: ReturnType<typeof mount>) => [...ui.timers.values()].filter(timer => timer.delay === 15000);

describe("automatic run status updates", () => {
  it.each([historyResult, { success: true, data: items(1) }, undefined])("reconnects history snapshots or the initial waiting view without replaying tools: %j", async snapshot => {
    const ui = mount(snapshot, { initialize: false });
    const previousRows = ui.node("histories").textContent;
    ui.expire(15000);
    await flush();
    const reconnect = ui.node("view-reconnect").click();
    ui.reply(ui.calls.filter(call => call.method === "ui/initialize").at(-1)!, { hostCapabilities: { serverTools: {} } });
    await reconnect;
    expect(ui.node("view-reconnect").hidden).toBe(true);
    expect(ui.node("badge").textContent).not.toBe("Unavailable");
    expect(ui.node("histories").textContent).toBe(previousRows);
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
    if (!snapshot) expect(ui.node("message").textContent).toContain("Waiting for Galaxy");
    ui.teardown();
    await ui.node("view-reconnect").click();
    expect(ui.calls.filter(call => call.method === "ui/initialize")).toHaveLength(2);
  });

  it("recovers an initialization timeout without replacing its snapshot or replaying a tool", async () => {
    const ui = mount({ success: true, run: running }, { initialize: false });
    const firstInitialize = ui.calls.find(call => call.method === "ui/initialize")!;
    const checked = ui.node("run-checked").textContent;
    ui.expire(15000);
    await flush();
    expect(ui.node("view-reconnect").hidden).toBe(false);
    expect(ui.node("run-refresh").disabled).toBe(true);
    const reconnect = ui.node("view-reconnect").click();
    await ui.node("view-reconnect").click();
    const initializes = ui.calls.filter(call => call.method === "ui/initialize");
    expect(initializes).toHaveLength(2);
    ui.reply(firstInitialize, {});
    expect(ui.node("run-refresh").disabled).toBe(true);
    ui.reply(initializes[1]!, { hostCapabilities: { serverTools: {} } });
    await reconnect;
    expect(ui.node("view-reconnect").hidden).toBe(true);
    expect(ui.node("run-refresh").disabled).toBe(false);
    expect(ui.node("run-checked").textContent).toBe(checked);
    expect(ui.node("badge").textContent).toBe("Unconfirmed");
    expect(statusCalls(ui)).toHaveLength(0);
    const refresh = ui.node("run-refresh").click();
    ui.reply(statusCalls(ui)[0]!, { structuredContent: { success: true, run: { ...running, state: "completed" } } });
    await refresh;
    expect(ui.node("badge").textContent).toBe("Completed");
    expect(statusCalls(ui)[0]!.params?.arguments).toEqual({ kind: "tool", runId: "private-run" });
  });

  it.each([true, false])("resumes a back/forward-cached view with an in-flight status request=%s, without duplicate work", async inFlight => {
    const ui = mount({ success: true, run: running });
    await flush();
    ui.intersect(true);
    if (inFlight) ui.expire(15000);
    ui.cache();
    expect(pollTimers(ui)).toHaveLength(0);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(inFlight ? 1 : 0);
    ui.restore();
    if (inFlight) {
      expect(pollTimers(ui)).toHaveLength(0);
      expect(ui.node("run-refresh").disabled).toBe(true);
      ui.reply(statusCalls(ui)[0]!, { structuredContent: { success: true, run: running } });
      await flush();
    }
    expect(pollTimers(ui)).toHaveLength(1);
    ui.expire(15000);
    const latest = statusCalls(ui).at(-1)!;
    ui.reply(latest, { structuredContent: { success: true, run: { ...running, state: "completed" } } });
    await flush();
    expect(ui.node("badge").textContent).toBe("Completed");
    expect(ui.pending()).toBe(0);
    expect(ui.timers.size).toBe(0);
    expect(ui.calls.filter(call => call.method === "tools/call").every(call => call.params?.name === "get_run_status" && call.params.arguments?.runId === "private-run")).toBe(true);
    ui.teardown();
    ui.restore();
    await ui.node("run-refresh").click();
    expect(ui.pending()).toBe(0);
    expect(ui.timers.size).toBe(0);
  });

  it("keeps the same run after a host authentication error and only reads it again after manual retry", async () => {
    const ui = mount({ success: true, run: running });
    await flush();
    ui.intersect(true);
    const checked = ui.node("run-checked").textContent;
    ui.expire(15000);
    ui.reject(statusCalls(ui)[0]!, { code: -32001, message: "Authentication required: sensitive diagnostic" });
    await flush();
    expect(ui.node("badge").textContent).toBe("Unconfirmed");
    expect(ui.node("run-checked").textContent).toBe(checked);
    expect(ui.node("run-warning").textContent).toContain("reconnect Galaxy in your client");
    expect(ui.node("run-warning").textContent).not.toContain("sensitive diagnostic");
    expect(ui.timers.size).toBe(0);
    const retry = ui.node("run-refresh").click();
    ui.reply(statusCalls(ui)[1]!, { structuredContent: { success: true, run: { ...running, state: "completed" } } });
    await retry;
    expect(ui.node("badge").textContent).toBe("Completed");
    expect(ui.calls.filter(call => call.method === "tools/call").map(call => call.params)).toEqual([
      { name: "get_run_status", arguments: { kind: "tool", runId: "private-run" } },
      { name: "get_run_status", arguments: { kind: "tool", runId: "private-run" } },
    ]);
  });

  it("keeps the snapshot but disables refresh when the host explicitly lacks server tools", async () => {
    const ui = mount(undefined, { standardHost: true, initializeResult: { hostCapabilities: {} } });
    await flush();
    ui.notify({ success: true, run: running });
    ui.intersect(true);
    await ui.node("run-refresh").click();
    await ui.node("run-results").click();
    ui.expire(15000);
    expect(ui.node("badge").textContent).toBe("Running");
    expect(ui.node("run-auto").textContent).toContain("does not support refreshing");
    expect(ui.node("run-refresh").disabled).toBe(true);
    expect(ui.node("run-results").disabled).toBe(true);
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
    expect(ui.timers.size).toBe(0);
  });

  it.each(["accepted", "queued", "running"])("polls %s runs serially after initialization and stops at completion", async state => {
    const ui = mount({ success: true, run: { ...running, state } }, { initialize: false });
    await ui.node("run-refresh").click();
    expect(statusCalls(ui)).toHaveLength(0);
    expect(ui.pending()).toBe(1);
    ui.reply(ui.calls.find(call => call.method === "ui/initialize")!, {});
    await flush();
    ui.intersect(true);
    expect(pollTimers(ui)).toHaveLength(1);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(1);
    expect(pollTimers(ui)).toHaveLength(0);
    ui.expire(15000);
    await ui.node("run-refresh").click();
    expect(statusCalls(ui)).toHaveLength(1);
    ui.reply(statusCalls(ui)[0]!, { structuredContent: { success: true, run: running } });
    await flush();
    expect(pollTimers(ui)).toHaveLength(1);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(2);
    ui.reply(statusCalls(ui)[1]!, { structuredContent: { success: true, run: { ...running, state: "completed" } } });
    await flush();
    expect(ui.node("badge").textContent).toBe("Completed");
    expect(ui.timers.size).toBe(0);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(2);
    expect(ui.calls.filter(call => call.method === "tools/call").every(call => call.params?.name === "get_run_status")).toBe(true);
  });

  it.each(["completed", "failed", "cancelled", "empty", "unknown"])("does not schedule checks for %s snapshots", async state => {
    const ui = mount({ success: true, run: { ...running, state } });
    await flush();
    ui.intersect(true);
    expect(ui.timers.size).toBe(0);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(0);
  });

  it("pauses after an automatic error or timeout, and a confirmed manual retry resumes polling", async () => {
    const ui = mount({ success: true, run: running });
    await flush();
    ui.intersect(true);
    const checked = ui.node("run-checked").textContent;
    ui.expire(15000);
    ui.reply(statusCalls(ui)[0]!, { isError: true });
    await flush();
    expect(ui.node("badge").textContent).toBe("Unconfirmed");
    expect(ui.node("run-checked").textContent).toBe(checked);
    expect(ui.timers.size).toBe(0);
    const retry = ui.node("run-refresh").click();
    ui.reply(statusCalls(ui)[1]!, { structuredContent: { success: true, run: running } });
    await retry;
    expect(pollTimers(ui)).toHaveLength(1);
    const manual = ui.node("run-refresh").click();
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(3);
    ui.reply(statusCalls(ui)[2]!, { structuredContent: { success: true, run: running } });
    await manual;
    ui.expire(15000);
    ui.expire(45000);
    await flush();
    expect(ui.node("badge").textContent).toBe("Unconfirmed");
    expect(ui.node("run-checked").textContent).toBe(checked);
    expect(ui.pending()).toBe(0);
    expect(ui.timers.size).toBe(0);
  });

  it("pauses hidden or offscreen cards and result browsing, resumes on return, and stops on pagehide", async () => {
    const ui = mount({ success: true, run: running });
    await flush();
    ui.intersect(true);
    expect(pollTimers(ui)).toHaveLength(1);
    ui.visibility(false);
    expect(ui.timers.size).toBe(0);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(0);
    ui.visibility(true);
    expect(pollTimers(ui)).toHaveLength(1);
    ui.intersect(false);
    expect(ui.timers.size).toBe(0);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(0);
    ui.intersect(true);
    expect(pollTimers(ui)).toHaveLength(1);

    const results = ui.node("run-results").click();
    expect(pollTimers(ui)).toHaveLength(0);
    ui.reply(ui.calls.filter(call => call.method === "tools/call").at(-1)!, { structuredContent: { success: true, data: items(1) } });
    await results;
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(0);
    await ui.node("history-back").click();
    expect(pollTimers(ui)).toHaveLength(1);
    ui.expire(15000);
    ui.reply(statusCalls(ui)[0]!, { structuredContent: { success: true, run: running } });
    await flush();
    expect(pollTimers(ui)).toHaveLength(1);
    ui.close();
    ui.visibility(true);
    ui.intersect(true);
    expect(ui.timers.size).toBe(0);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(1);
  });

  it("does not overlap status requests when navigating away and back before a response", async () => {
    const ui = mount({ success: true, run: running });
    await flush();
    ui.intersect(true);
    const refresh = ui.node("run-refresh").click();
    const status = statusCalls(ui)[0]!;
    const results = ui.node("run-results").click();
    const history = ui.calls.filter(call => call.method === "tools/call").at(-1)!;
    await ui.node("history-back").click();
    expect(ui.node("run-refresh").disabled).toBe(true);
    expect(pollTimers(ui)).toHaveLength(0);
    ui.expire(15000);
    await ui.node("run-refresh").click();
    expect(statusCalls(ui)).toHaveLength(1);
    ui.reply(status, { structuredContent: { success: true, run: { ...running, state: "completed" } } });
    await refresh;
    ui.reply(history, { structuredContent: { success: true, data: items(1) } });
    await results;
    expect(ui.node("badge").textContent).toBe("Running");
    expect(ui.node("run-refresh").disabled).toBe(false);
    expect(pollTimers(ui)).toHaveLength(1);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(2);
    ui.close();
    await flush();
  });

  it("uses document visibility when IntersectionObserver is unavailable, including responses received while hidden", async () => {
    const ui = mount({ success: true, run: running }, { intersectionObserver: false });
    await flush();
    expect(pollTimers(ui)).toHaveLength(1);
    ui.expire(15000);
    ui.visibility(false);
    ui.reply(statusCalls(ui)[0]!, { structuredContent: { success: true, run: running } });
    await flush();
    expect(ui.timers.size).toBe(0);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(1);
    ui.visibility(true);
    expect(pollTimers(ui)).toHaveLength(1);
    ui.close();
  });

  it("handles standard MCP Apps results, theme changes, and teardown without OpenAI globals", async () => {
    const ui = mount(undefined, { standardHost: true, initializeResult: { hostContext: { theme: "dark" } } });
    await flush();
    expect(ui.root.style.colorScheme).toBe("dark");
    ui.notify({ success: true, run: running });
    expect(ui.node("title").textContent).toBe("Read quality check");
    ui.hostContext({ theme: "light" });
    expect(ui.root.style.colorScheme).toBe("light");
    ui.hostContext({ theme: "invalid" });
    expect(ui.root.style.colorScheme).toBe("light");
    ui.intersect(true);
    ui.expire(15000);
    const pendingStatus = statusCalls(ui)[0]!;
    expect(ui.pending()).toBe(1);
    // Host request IDs have their own namespace and can match an outstanding app request.
    ui.teardown(pendingStatus.id);
    await flush();
    expect(ui.pending()).toBe(0);
    expect(ui.timers.size).toBe(0);
    expect(ui.calls.some(call => call.id === pendingStatus.id && !call.method && "result" in call)).toBe(true);
    ui.reply(pendingStatus, { structuredContent: { success: true, run: { ...running, state: "completed" } } });
    ui.visibility(true);
    ui.intersect(true);
    ui.expire(15000);
    expect(statusCalls(ui)).toHaveLength(1);
    expect(ui.node("badge").textContent).not.toBe("Completed");
  });
});
