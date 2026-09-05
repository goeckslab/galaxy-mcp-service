import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { HISTORY_SUMMARY_URI, registerHistorySummaryResource } from "../../apps/service/src/history-summary-ui.js";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  hidden = false;
  disabled = false;
  focused = false;
  removed = false;
  className = "";
  tabIndex = -1;
  open = false;
  srcdoc = "";
  private text = "";
  constructor(public tagName: string) {}
  get childElementCount() { return this.children.length; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get outerHTML() { return "<html></html>"; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  append(...children: Element[]) { this.children.push(...children); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.text = ""; this.children = children; }
  addEventListener(name: string, listener: () => unknown) { this.listeners.set(name, listener); }
  click() { return this.listeners.get("click")?.(); }
  focus() { this.focused = true; }
  remove() { this.removed = true; }
  getBoundingClientRect() { return { height: 500 }; }
}

interface Rpc {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const resources = new Map<string, string>();
registerHistorySummaryResource({
  registerResource(_name: string, uri: string, _metadata: unknown, read: (uri: URL) => { contents: { text: string }[] }) {
    resources.set(uri, read(new URL(uri)).contents[0]!.text);
  },
} as unknown as Parameters<typeof registerHistorySummaryResource>[0]);
const html = resources.get(HISTORY_SUMMARY_URI)!;
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

function mount(initial?: unknown, options: { initialize?: boolean; reply?: (rpc: Rpc) => unknown; elements?: Element[] } = {}) {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element("DIV")]));
  const root = new Element("HTML");
  const head = new Element("HEAD");
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Map<string, (event: unknown) => void>();
  const calls: Rpc[] = [];
  let timerId = 0;
  const emit = (name: string, event: unknown) => listeners.get(name)?.(event);
  const parent = {
    postMessage(rpc: Rpc) {
      calls.push(rpc);
      if (rpc.method === "ui/initialize" && options.initialize !== false) reply(rpc, {});
      else if (rpc.method === "tools/call" && options.reply) reply(rpc, options.reply(rpc));
    },
  };
  function reply(rpc: Rpc, result: unknown) {
    emit("message", { source: parent, data: { jsonrpc: "2.0", id: rpc.id, result } });
  }
  const context = createContext({
    window: { parent, openai: { toolOutput: initial, theme: "light" } },
    document: { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new Element(tag.toUpperCase()), documentElement: root },
    addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    DOMParser: class {
      parseFromString() {
        return { head, documentElement: root, createElement: (tag: string) => new Element(tag.toUpperCase()), querySelectorAll: (selector: string) => selector === "*" ? options.elements ?? [] : (options.elements ?? []).filter(element => selector.split(",").includes(element.tagName.toLowerCase())) };
      }
    },
  });
  runInContext(script, context);
  return {
    node: (id: string) => nodes.get(id)!, root, head, calls, timers, reply,
    pending: () => runInContext("pending.size", context) as number,
    notify: (value: unknown) => emit("message", { source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: value } } }),
    globals: (value: unknown) => emit("openai:set_globals", { detail: { globals: value } }),
    resize: () => emit("resize", {}),
    close: () => emit("pagehide", {}),
    sanitize: () => runInContext('sandboxHtml("<fixture>")', context),
    expire: (delay: number) => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
  };
}

const items = (count: number, start = 0) => Array.from({ length: count }, (_, index) => ({ id: "private-dataset-" + (start + index), name: "Result " + (start + index), state: "ok", extension: "txt" }));
const historyResult = { status: "connected", histories: [{ id: "private-history", name: "RNA analysis", state: "ok" }] };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("history result browser", () => {
  it("serves every published URI and reveals every returned item without inventing a total", async () => {
    expect(resources.size).toBe(9);
    expect([...resources.values()].every(value => value === html)).toBe(true);
    const ui = mount({ success: true, data: items(25) });
    expect(ui.node("histories").children).toHaveLength(20);
    expect(ui.node("message").textContent).toContain("20 of 25 loaded");
    expect(ui.node("histories").textContent).not.toContain("private-dataset");
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(25);
    expect(ui.node("show-more").hidden).toBe(true);
    expect(ui.calls.filter(call => call.method === "tools/call")).toHaveLength(0);
    const histories = mount({ status: "connected", histories: items(25) }, { reply: () => ({ structuredContent: { success: true, data: [] } }) });
    expect(histories.node("message").textContent).toContain("20 of 25 returned histories");
    await histories.node("show-more").click();
    await histories.node("histories").children[24]!.children[0]!.click();
    await histories.node("history-back").click();
    expect(histories.node("histories").children).toHaveLength(25);
  });

  it("navigates a history, appends a remote page, and ignores host replay during browsing", async () => {
    const ui = mount(historyResult, { reply: rpc => {
      const offset = Number(rpc.params?.arguments?.offset);
      return { structuredContent: { success: true, data: items(offset ? 1 : 20, offset), history_id: "private-history", pagination: { offset, limit: 20, returned: offset ? 1 : 20, has_more: !offset, next_offset: 20 } } };
    } });
    await ui.node("histories").children[0]!.children[0]!.click();
    expect(ui.node("breadcrumbs").hidden).toBe(false);
    expect(ui.node("history-name").textContent).toBe("RNA analysis");
    expect(ui.node("message").textContent).toContain("more available");
    ui.notify(historyResult);
    ui.globals({ toolOutput: historyResult, theme: "dark" });
    expect(ui.node("title").textContent).toBe("History contents");
    expect(ui.root.style.colorScheme).toBe("dark");
    ui.resize();
    expect(ui.calls.at(-1)?.method).toBe("ui/notifications/size-changed");
    await ui.node("show-more").click();
    expect(ui.calls.filter(call => call.method === "tools/call").map(call => call.params?.arguments)).toEqual([
      { historyId: "private-history", limit: 20, offset: 0 }, { historyId: "private-history", limit: 20, offset: 20 },
    ]);
    expect(ui.node("histories").children).toHaveLength(21);
    expect(ui.node("show-more").hidden).toBe(true);
    await ui.node("history-back").click();
    expect(ui.node("histories").textContent).toContain("RNA analysis");
    expect(ui.pending()).toBe(0);
    expect(ui.timers.size).toBe(0);
  });

  it("keeps prior results when pagination fails and permits retry", async () => {
    const ui = mount({ success: true, data: items(20), history_id: "private-history", pagination: { offset: 0, returned: 20, has_more: true, next_offset: 20 } }, { reply: () => ({ isError: true }) });
    await ui.node("show-more").click();
    expect(ui.node("histories").children).toHaveLength(20);
    expect(ui.node("show-more").textContent).toBe("Retry loading more");
    expect(ui.node("show-more").disabled).toBe(false);
  });

  it("does not replace Histories with a late response after Back", async () => {
    const ui = mount(historyResult);
    const loading = ui.node("histories").children[0]!.children[0]!.click();
    await ui.node("history-back").click();
    ui.reply(ui.calls.find(call => call.method === "tools/call")!, { structuredContent: { success: true, data: items(1) } });
    await loading;
    expect(ui.node("title").textContent).toBe("Galaxy histories");
    expect(ui.node("histories").textContent).toContain("RNA analysis");
  });

  it("times out absent host replies, restores controls, and clears pending work on close", async () => {
    const ui = mount({ success: true, data: items(1) });
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
    await ui.node("histories").children[0]!.children[0]!.click();
    const raw = ui.node("detail-body").children[0]!.children[1]!;
    expect(raw.textContent).toBe(text);
    expect(raw.tabIndex).toBe(0);
    expect(ui.node("detail-message").textContent).toContain("truncated");
    expect(ui.node("detail-close").focused).toBe(true);
    await ui.node("detail-close").click();
    expect(ui.node("dataset-detail").hidden).toBe(true);
  });

  it("retains local links and SVG references while removing external and executable attributes", () => {
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
    const scriptElement = new Element("SCRIPT");
    const animation = new Element("SET");
    animation.setAttribute("attributeName", "href");
    animation.setAttribute("to", "https://example.test/");
    const ui = mount(undefined, { elements: [anchor, use, external, unsafe, image, scriptElement, animation] });
    ui.sanitize();
    expect(anchor.attrs).toEqual(new Map([["href", "about:srcdoc#statistics"]]));
    expect(use.attrs.get("xlink:href")).toBe("#plot-symbol");
    expect(use.attrs.has("xml:base")).toBe(false);
    expect(external.attrs.size + unsafe.attrs.size + image.attrs.size).toBe(0);
    expect(scriptElement.removed).toBe(true);
    expect(animation.removed).toBe(true);
    expect(ui.head.children[0]!.attrs.get("content")).toContain("connect-src 'none'");
    expect(html).toContain('frame.setAttribute("sandbox", "")');
  });
});
