import type { McpServer } from "@modelcontextprotocol/server";

export const HISTORY_SUMMARY_URI = "ui://galaxy/history-summary-v18.html";

const LEGACY_HISTORY_SUMMARY_URIS = [
  "ui://galaxy/history-summary-v1.html",
  "ui://galaxy/history-summary-v2.html",
  "ui://galaxy/history-summary-v3.html",
  "ui://galaxy/history-summary-v4.html",
  "ui://galaxy/history-summary-v5.html",
  "ui://galaxy/history-summary-v6.html",
  "ui://galaxy/history-summary-v7.html",
  "ui://galaxy/history-summary-v8.html",
  "ui://galaxy/history-summary-v9.html",
  "ui://galaxy/history-summary-v10.html",
  "ui://galaxy/history-summary-v11.html",
  "ui://galaxy/history-summary-v12.html",
  "ui://galaxy/history-summary-v13.html",
  "ui://galaxy/history-summary-v14.html",
  "ui://galaxy/history-summary-v15.html",
  "ui://galaxy/history-summary-v16.html",
  "ui://galaxy/history-summary-v17.html",
] as const;

const MIME_TYPE = "text/html;profile=mcp-app";
// Embedded, unmodified Galaxy symbol by Petr Kadlec.
// Asset and usage conditions: https://artifact.galaxyproject.org/images/galaxy-logos/
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Galaxy histories</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      --text: light-dark(#1d1d1f, #f5f5f7);
      --secondary: light-dark(#6e6e73, #a1a1a6);
      --surface: light-dark(rgba(255, 255, 255, .94), rgba(28, 28, 30, .96));
      --row: light-dark(rgba(0, 0, 0, .025), rgba(255, 255, 255, .045));
      --hover: light-dark(rgba(0, 113, 227, .055), rgba(41, 151, 255, .09));
      --line: light-dark(rgba(0, 0, 0, .08), rgba(255, 255, 255, .11));
      --accent: light-dark(#0071e3, #2997ff);
      --success: light-dark(#248a3d, #30d158);
      --danger: light-dark(#d70015, #ff453a);
      --purple: light-dark(#8944ab, #bf5af2);
      --orange: light-dark(#c93400, #ff9f0a);
      --shadow: 0 2px 12px var(--line);
      --scroll-track: light-dark(rgba(0, 0, 0, .05), rgba(255, 255, 255, .06));
      --scroll-thumb: light-dark(rgba(0, 0, 0, .24), rgba(255, 255, 255, .3));
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px; color: var(--text); background: transparent; }
    .card {
      position: relative;
      overflow: hidden;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 22px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .brand-heading { display: flex; align-items: center; gap: 11px; min-width: 0; }
    .brand-mark { display: grid; place-items: center; flex: none; width: 42px; height: 42px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
    .brand-mark img { display: block; width: 32px; height: auto; }
    h1 { margin: 0; font-size: 1.12rem; font-weight: 650; letter-spacing: -.025em; line-height: 1.25; }
    h2 { overflow: hidden; margin: 0; font-size: .92rem; font-weight: 620; letter-spacing: -.012em; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    p { margin: 0; }
    .badge { display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: var(--row); color: var(--secondary); box-shadow: inset 0 0 0 1px var(--line); font-size: .72rem; font-weight: 600; }
    .badge::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent); content: ""; }
    .badge[data-state="connected"] { color: var(--success); }
    .badge[data-state="error"] { color: var(--danger); }
    .badge[data-state="running"] { color: var(--accent); }
    .badge[data-state="unknown"] { color: var(--orange); }
    .instance, .message, .meta { color: var(--secondary); }
    .instance { margin-top: 4px; font-size: .76rem; overflow-wrap: anywhere; }
    .message { margin-top: 14px; color: var(--secondary); font-size: .86rem; line-height: 1.45; }
    ul { display: grid; gap: 0; margin: 16px 0 0; padding: 0; border-top: 1px solid var(--line); list-style: none; }
    li { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-width: 0; padding: 12px 4px; border-bottom: 1px solid var(--line); background: transparent; }
    .summary { min-width: 0; }
    .state { margin-top: 4px; color: var(--secondary); font-size: .76rem; text-transform: capitalize; }
    .state[data-state="ok"] { color: var(--success); }
    .state[data-state="error"], .state[data-state="failed"] { color: var(--danger); }
    .meta { display: grid; flex: none; gap: 3px; overflow-wrap: anywhere; text-align: right; font-size: .72rem; line-height: 1.25; }
    li[data-view="content"] { justify-content: flex-start; }
    .kind { display: grid; flex: none; width: 42px; height: 42px; place-items: center; border-radius: 12px; background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 14%, transparent); font-size: .64rem; font-weight: 750; letter-spacing: .035em; }
    .kind[data-kind="report"] { background: color-mix(in srgb, var(--purple) 11%, transparent); color: var(--purple); }
    .kind[data-kind="raw"] { background: color-mix(in srgb, var(--orange) 11%, transparent); color: var(--orange); }
    .detail { margin-top: 3px; color: var(--secondary); font-size: .75rem; }
    .status { padding: 5px 8px; border-radius: 999px; background: color-mix(in srgb, currentColor 9%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 14%, transparent); color: var(--secondary); font-weight: 650; text-transform: capitalize; }
    .status[data-state="ok"] { color: var(--success); }
    .status[data-state="error"] { color: var(--danger); }
    li[data-view="content"] .meta { margin-left: auto; }
    li[data-clickable="true"] { padding: 0; }
    .content-button { display: flex; align-items: center; gap: 14px; width: 100%; min-width: 0; padding: 12px 4px; border: 0; border-radius: 12px; color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer; transition: background-color 140ms ease; }
    .content-button .summary { flex: 1; }
    .content-button:hover { background: var(--hover); }
    .content-button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .content-button:disabled { cursor: default; opacity: .66; }
    .view { color: var(--accent); font-weight: 650; }
    .breadcrumbs { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; color: var(--secondary); font-size: .76rem; }
    .breadcrumbs span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }
    .more-button { margin-top: 14px; }
    .dataset-detail { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
    .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .detail-header > div { min-width: 0; }
    .dataset-detail h2 { white-space: normal; }
    .close-button { min-height: 32px; padding: 5px 10px; border: 0; border-radius: 999px; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); font: inherit; font-size: .76rem; font-weight: 650; cursor: pointer; }
    .close-button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .close-button:disabled { color: var(--secondary); background: var(--row); cursor: default; }
    #history-link, #report-link { display: inline-flex; align-items: center; margin-top: 14px; text-decoration: none; }
    #history-link:hover, #report-link:hover { text-decoration: underline; }
    .run-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .run-actions .close-button { min-height: 38px; padding: 8px 14px; }
    .run-warning { margin-top: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--orange) 25%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--orange) 6%, transparent); color: var(--orange); font-size: .78rem; line-height: 1.45; }
    #run-jobs .stat:last-child { grid-column: 1 / -1; }
    .scores { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 14px; }
    .score { padding: 10px; border-radius: 12px; background: color-mix(in srgb, currentColor 7%, transparent); color: var(--secondary); text-align: center; }
    .score strong { display: block; font-size: 1.2rem; }
    .score span { font-size: .7rem; font-weight: 650; text-transform: uppercase; }
    .score[data-state="pass"] { color: var(--success); }
    .score[data-state="fail"] { color: var(--danger); }
    .score[data-state="warn"] { color: var(--orange); }
    .section-title { margin-top: 16px; font-size: .78rem; font-weight: 700; }
    .statistics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin: 8px 0 0; }
    .stat { min-width: 0; padding: 9px 10px; border-radius: 11px; background: color-mix(in srgb, var(--surface) 72%, transparent); }
    .stat dt { color: var(--secondary); font-size: .67rem; }
    .stat dd { overflow-wrap: anywhere; margin: 3px 0 0; font-size: .79rem; font-weight: 620; }
    .modules { display: grid; gap: 5px; margin-top: 8px; }
    .module { display: flex; justify-content: space-between; gap: 12px; padding: 7px 9px; border-radius: 10px; background: color-mix(in srgb, var(--surface) 72%, transparent); font-size: .75rem; }
    .module > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    .module-status { flex: none; font-weight: 700; text-transform: uppercase; }
    .module-status[data-state="pass"] { color: var(--success); }
    .module-status[data-state="warn"] { color: var(--orange); }
    .module-status[data-state="fail"] { color: var(--danger); }
    .caveat { margin-top: 12px; color: var(--secondary); font-size: .72rem; line-height: 1.4; }
    details { margin-top: 14px; }
    summary { color: var(--accent); font-size: .78rem; font-weight: 650; cursor: pointer; }
    pre { max-width: 100%; max-height: 360px; overflow-x: scroll; overflow-y: auto; overscroll-behavior-inline: contain; scrollbar-gutter: stable; margin: 9px 0 0; padding: 11px; border-radius: 11px; background: color-mix(in srgb, CanvasText 6%, transparent); font: .69rem/1.42 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; overflow-wrap: normal; word-break: normal; user-select: text; }
    .report-note { margin-top: 12px; color: var(--secondary); font-size: .72rem; line-height: 1.4; }
    .report-scroll { max-width: 100%; max-height: 620px; margin-top: 10px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
    .report-preview { min-width: 0; padding: 18px; font-size: .82rem; line-height: 1.55; overflow-wrap: anywhere; }
    .report-preview :is(h1,h2,h3,h4,h5,h6) { margin: 20px 0 8px; font-size: 1rem; white-space: normal; overflow: visible; }
    .report-preview :is(p,table,pre,blockquote,dl) { margin: 10px 0; }
    .report-preview :is(ul,ol) { display: block; margin: 8px 0; padding-left: 22px; border: 0; list-style: revert; }
    .report-preview li { display: list-item; padding: 3px 0; border: 0; }
    .report-preview table { border-collapse: collapse; min-width: min(100%, 440px); }
    .report-preview :is(th,td) { padding: 8px 12px; border: 1px solid var(--line); text-align: left; white-space: nowrap; }
    .report-preview th { background: var(--row); }
    .report-preview img { max-width: none; height: auto; vertical-align: middle; background: white; }
    @supports not selector(::-webkit-scrollbar) {
      pre, .report-scroll { scrollbar-color: var(--scroll-thumb) var(--scroll-track); scrollbar-width: thin; }
    }
    pre::-webkit-scrollbar, .report-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
    pre::-webkit-scrollbar-track, .report-scroll::-webkit-scrollbar-track { background: var(--scroll-track); }
    pre::-webkit-scrollbar-thumb, .report-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: var(--scroll-thumb); background-clip: padding-box; }
    pre:focus-visible, .report-scroll:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 520px) { body { padding: 6px; } .card { padding: 16px; border-radius: 18px; } header { gap: 10px; } li, .content-button { align-items: flex-start; } .meta { max-width: 42%; } .statistics { grid-template-columns: 1fr; } }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main class="card" aria-labelledby="title">
    <nav id="breadcrumbs" class="breadcrumbs" aria-label="History navigation" hidden>
      <button id="history-back" class="close-button" type="button">‹ Histories</button>
      <span id="history-name"></span>
    </nav>
    <header>
      <div class="brand-heading">
        <span class="brand-mark"><img alt="Galaxy" width="597" height="451" src="data:image/png;base64,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"></span>
        <div>
        <h1 id="title">Galaxy histories</h1>
        <p id="instance" class="instance" hidden></p>
        </div>
      </div>
      <span id="badge" class="badge">Waiting</span>
    </header>
    <a id="history-link" class="close-button" target="_blank" rel="noopener noreferrer" title="Open this history in Galaxy (new tab)" hidden>Open history in Galaxy ↗</a>
    <p id="history-link-note" class="caveat" role="status" hidden></p>
    <p id="message" class="message" role="status" aria-live="polite">Waiting for Galaxy…</p>
    <button id="view-reconnect" class="close-button" type="button" hidden>Reconnect view</button>
    <section id="run-panel" aria-label="Analysis run status" hidden>
      <p id="run-checked" class="detail"></p>
      <p id="run-auto" class="detail"></p>
      <p id="run-warning" class="run-warning" role="status" aria-live="polite" hidden></p>
      <dl id="run-jobs" class="statistics" aria-label="Job counts" hidden></dl>
      <div class="run-actions">
        <button id="run-refresh" class="close-button" type="button">Refresh status</button>
        <button id="run-results" class="close-button" type="button">View history results</button>
      </div>
      <p id="run-results-note" class="caveat">History results may include inputs and outputs from other runs.</p>
    </section>
    <ul id="histories" aria-label="Galaxy histories" hidden></ul>
    <div class="list-actions">
      <button id="show-less" class="close-button more-button" type="button" aria-controls="histories" hidden>Load less</button>
      <button id="show-more" class="close-button more-button" type="button" aria-controls="histories" hidden>Load more</button>
    </div>
    <section id="dataset-detail" class="dataset-detail" aria-labelledby="detail-title" hidden>
      <div class="detail-header">
        <div>
          <h2 id="detail-title">Dataset contents</h2>
          <p id="detail-message" class="detail" role="status" aria-live="polite"></p>
        </div>
        <button id="detail-close" class="close-button" type="button">‹ Results</button>
      </div>
      <a id="report-link" class="close-button" target="_blank" rel="noopener noreferrer" title="Open the original report in Galaxy (new tab)" hidden>Open original in Galaxy ↗</a>
      <p id="report-link-note" class="caveat" role="status" hidden></p>
      <div id="detail-body"></div>
    </section>
  </main>
  <script>
    const badge = document.getElementById("badge");
    const title = document.getElementById("title");
    const instance = document.getElementById("instance");
    const message = document.getElementById("message");
    const viewReconnect = document.getElementById("view-reconnect");
    const runPanel = document.getElementById("run-panel");
    const runChecked = document.getElementById("run-checked");
    const runAuto = document.getElementById("run-auto");
    const runWarning = document.getElementById("run-warning");
    const runJobs = document.getElementById("run-jobs");
    const runRefresh = document.getElementById("run-refresh");
    const runResults = document.getElementById("run-results");
    const runResultsNote = document.getElementById("run-results-note");
    const histories = document.getElementById("histories");
    const breadcrumbs = document.getElementById("breadcrumbs");
    const historyBack = document.getElementById("history-back");
    const historyName = document.getElementById("history-name");
    const historyLink = document.getElementById("history-link");
    const historyLinkNote = document.getElementById("history-link-note");
    const showMore = document.getElementById("show-more");
    const showLess = document.getElementById("show-less");
    const datasetDetail = document.getElementById("dataset-detail");
    const detailTitle = document.getElementById("detail-title");
    const detailMessage = document.getElementById("detail-message");
    const detailBody = document.getElementById("detail-body");
    const detailClose = document.getElementById("detail-close");
    const reportLink = document.getElementById("report-link");
    const reportLinkNote = document.getElementById("report-link-note");
    const labels = { connected: "Connected", not_configured: "Not configured", error: "Error" };
    const browsingUnavailable = " This host does not support browsing from this card. Ask for a history or report in chat.";
    const string = value => typeof value === "string" ? value : "";
    const stateLabels = { ok: "Ready", new: "Preparing", upload: "Uploading", queued: "Queued", running: "Running", waiting: "Waiting", paused: "Paused", error: "Failed", failed: "Failed", discarded: "Discarded", deleted: "Deleted", empty: "Empty", setting_metadata: "Preparing metadata" };
    const stateLabel = value => Object.hasOwn(stateLabels, string(value).toLowerCase()) ? stateLabels[string(value).toLowerCase()] : "Status unavailable";
    const readableExtensions = new Set(["txt", "tabular", "csv", "tsv"]);
    const pending = new Map();
    let nextRequestId = 1;
    let detailRequestId = 0;
    let activeContentButton;
    let initialized = false;
    let initializing = false;
    let canCallTools = true;
    let canUpdateContext = false;
    let canOpenLinks = false;
    const seenViewIds = new Set();
    let sourceViewId;
    let sourceGalaxy;
    let viewContext;
    let lastSentContext;
    let closed = false;
    let suspended = false;
    let localNavigation = false;
    let viewRequestId = 0;
    let historyList;
    let currentHistory;
    let currentContents;
    let directDataset;
    let directOpenStarted = false;
    const CONTENT_PAGE_SIZE = 5;
    let visibleCount = CONTENT_PAGE_SIZE;
    let historyVisibleCount = CONTENT_PAGE_SIZE;
    let firstOffset = 0;
    let canShowMore = false;
    let currentRun;
    let runRefreshing = false;
    let runUnconfirmed = false;
    let runTimer;
    let cardVisible = typeof IntersectionObserver === "undefined";
    const runStateLabels = { accepted: "Submitted", queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled", empty: "No analysis ran", unknown: "Status unknown" };
    const runMessages = { accepted: "Galaxy accepted this analysis.", queued: "Waiting for Galaxy to start the jobs.", running: "Galaxy is processing this analysis.", completed: "Processing has finished. Review the results to assess their quality.", failed: "This analysis failed. Review the available details and any partial results.", cancelled: "This analysis was cancelled. Existing results may still be available.", empty: "No analysis ran: no jobs were created, or every job was skipped.", unknown: "The current state could not be confirmed." };

    function post(message) {
      window.parent.postMessage(message, "*");
    }

    function toolsAvailable() {
      return initialized && canCallTools && !closed;
    }

    function setHistoryLink(data) {
      historyLink.hidden = true;
      historyLink.removeAttribute("href");
      historyLinkNote.hidden = true;
      try {
        if (data?.success !== true || !string(data.history_id)) return;
        const url = new URL(data.history_url);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.searchParams.get("id") !== data.history_id) return;
        historyLink.setAttribute("href", url.href);
        historyLink.hidden = false;
      } catch { /* Older results without a valid history URL have no link. */ }
    }

    function bindGalaxyLink(link, note) {
      link.addEventListener("click", async event => {
        if (!canOpenLinks) return; // Native link for hosts without the optional MCP Apps capability.
        event.preventDefault();
        const url = link.getAttribute("href");
        if (link.hidden || !url) return;
        note.hidden = true;
        try {
          await request("ui/open-link", { url });
        } catch {
          if (link.getAttribute("href") !== url || link.hidden) return;
          note.textContent = "The host could not open this link. You can copy the link address and open it in your browser.";
          note.hidden = false;
          sendSize();
        }
      });
    }
    bindGalaxyLink(historyLink, historyLinkNote);
    bindGalaxyLink(reportLink, reportLinkNote);

    function setReportLink(data) {
      reportLink.hidden = true;
      reportLink.removeAttribute("href");
      reportLinkNote.hidden = true;
      try {
        if (!string(data?.dataset_id)) return;
        const url = new URL(data.url);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
          || !url.pathname.endsWith("/datasets/" + encodeURIComponent(data.dataset_id) + "/display")) return;
        reportLink.setAttribute("href", url.href);
        reportLink.hidden = false;
      } catch { /* Old responses without a canonical report URL remain readable. */ }
    }

    function request(method, params, timeoutMs = 45000) {
      if (closed) return Promise.reject(new Error("Galaxy view closed"));
      if (method === "tools/call" && !toolsAvailable()) return Promise.reject(new Error("This Galaxy view cannot call tools"));
      const expectedSource = method === "tools/call" ? sourceGalaxy : undefined;
      if (expectedSource) params = { ...params, arguments: { ...params.arguments, instance: expectedSource.instance } };
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Galaxy view request timed out"));
        }, timeoutMs);
        pending.set(id, { resolve: result => {
          const actual = result?.structuredContent?.galaxy;
          if (expectedSource && !result?.isError && (actual?.instance !== expectedSource.instance || actual?.url !== expectedSource.url)) {
            reject(new Error("Galaxy response source did not match this card"));
          } else resolve(result);
        }, reject, timer });
        try {
          post({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    }

    function sendSize() {
      if (!initialized) return;
      requestAnimationFrame(() => post({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: Math.ceil(document.documentElement.getBoundingClientRect().height) },
      }));
    }

    function publishView(value) {
      viewContext = { ...value, ...(sourceGalaxy && { galaxy: sourceGalaxy }), view_id: sourceViewId || null, display_verified: false,
        scope: "This card only, not other tool calls or the user's workspace. Content loading does not verify visible display." };
      if (!initialized || !canUpdateContext || closed) return;
      const serialized = JSON.stringify(viewContext);
      if (serialized === lastSentContext) return;
      lastSentContext = serialized;
      // Host context updates inform future turns; they do not verify what a person has seen.
      void request("ui/update-model-context", { structuredContent: viewContext }, 5000).catch(() => {});
    }

    function updateListVisibility() {
      histories.hidden = !datasetDetail.hidden || histories.childElementCount === 0;
      message.hidden = !datasetDetail.hidden;
      showMore.hidden = !datasetDetail.hidden || !canShowMore;
      showLess.hidden = !datasetDetail.hidden || histories.childElementCount <= CONTENT_PAGE_SIZE;
    }

    function syncRunRefresh() {
      clearTimeout(runTimer);
      runTimer = undefined;
      const pendingRun = ["accepted", "queued", "running"].includes(currentRun?.state);
      const uncertain = runUnconfirmed || currentRun?.state === "unknown";
      const visible = document.visibilityState === "visible" && cardVisible && !runPanel.hidden;
      runAuto.textContent = !canCallTools ? "This host does not support refreshing from this card. Ask for a new status check in chat."
        : uncertain ? "Auto-refresh paused. Retry the status check to resume."
        : !pendingRun ? "Auto-refresh stopped. You can still refresh manually."
        : "Auto-refresh every 15 seconds while this card is visible.";
      if (!initialized || closed || suspended || !visible || uncertain || !pendingRun || runRefreshing || runRefresh.disabled) return;
      // Schedule after each response, never overlap requests or poll while browsing results.
      runTimer = setTimeout(() => { runTimer = undefined; void refreshRun(); }, 15000);
    }

    function renderRun() {
      setHistoryLink();
      closeDatasetDetail(false);
      runPanel.hidden = false;
      runPanel.setAttribute("aria-busy", String(runRefreshing));
      breadcrumbs.hidden = true;
      histories.replaceChildren();
      canShowMore = false;
      updateListVisibility();
      const state = Object.hasOwn(runStateLabels, currentRun.state) ? currentRun.state : "unknown";
      title.textContent = string(currentRun.name) || (currentRun.kind === "workflow" ? "Galaxy workflow" : "Galaxy tool run");
      instance.textContent = sourceLabel() || (currentRun.kind === "workflow" ? "Workflow run" : "Tool run");
      instance.hidden = false;
      badge.dataset.state = runUnconfirmed || state === "unknown" ? "unknown" : state === "completed" ? "connected" : state === "failed" ? "error" : state === "running" ? "running" : "neutral";
      badge.textContent = runUnconfirmed ? "Unconfirmed" : runStateLabels[state];
      message.textContent = string(currentRun.message) || runMessages[state];
      const checked = new Date(string(currentRun.checked_at));
      runChecked.textContent = Number.isNaN(checked.getTime()) ? "No confirmed status check yet." : "Last checked " + checked.toLocaleString();
      runWarning.hidden = !runUnconfirmed;
      runWarning.textContent = "The current status is unconfirmed. " + (state === "unknown" ? "Refresh status to try again." : "Last known status: " + runStateLabels[state] + ". Refresh status to try again.") + " If sign-in is required, reconnect Galaxy in your client before retrying.";
      runJobs.replaceChildren();
      for (const [key, label] of [["completed", "Completed jobs"], ["failed", "Failed jobs"], ["running", "Running jobs"], ["queued", "Queued jobs"], ["other", "Other jobs"], ["total", "Total jobs"]]) {
        const count = currentRun.jobs?.[key];
        if (!Number.isSafeInteger(count) || count < 0 || (key === "other" && count === 0)) continue;
        const stat = document.createElement("div");
        const term = document.createElement("dt");
        const value = document.createElement("dd");
        stat.className = "stat";
        term.textContent = label;
        value.textContent = String(count);
        stat.append(term, value);
        runJobs.append(stat);
      }
      runJobs.hidden = runJobs.childElementCount === 0;
      runRefresh.disabled = !toolsAvailable() || runRefreshing || !string(currentRun.id) || !["tool", "workflow"].includes(currentRun.kind);
      runRefresh.textContent = runRefreshing ? "Checking…" : runUnconfirmed ? "Retry status check" : "Refresh status";
      runResults.disabled = !toolsAvailable() || !string(currentRun.history_id);
      runResultsNote.textContent = runResults.disabled ? "History results are not available for this run yet." : "History results may include inputs and outputs from other runs.";
      syncRunRefresh();
      publishView({ view: "run_status", report_status: "not_open", state, checked_at: currentRun.checked_at });
    }

    async function refreshRun() {
      if (closed || runPanel.hidden || runRefreshing || runRefresh.disabled || !currentRun) return;
      localNavigation = true;
      const requestId = ++viewRequestId;
      const previous = currentRun;
      runRefreshing = true;
      renderRun();
      sendSize();
      try {
        const result = await request("tools/call", { name: "get_run_status", arguments: { kind: previous.kind, runId: previous.id } });
        if (requestId !== viewRequestId) return;
        const data = result?.structuredContent;
        if (result?.isError || data?.success !== true || data.run?.id !== previous.id || data.run?.kind !== previous.kind) throw new Error("Run status unavailable");
        currentRun = data.run;
        runUnconfirmed = false;
      } catch {
        if (requestId !== viewRequestId) return;
        runUnconfirmed = true;
      } finally {
        runRefreshing = false;
        if (!closed && !runPanel.hidden) {
          renderRun();
          sendSize();
        }
      }
    }

    runRefresh.addEventListener("click", refreshRun);
    runResults.addEventListener("click", () => {
      if (!currentRun || runResults.disabled) return;
      return openHistory({ id: currentRun.history_id, name: "History results" });
    });

    function renderHistories(data) {
      setHistoryLink();
      closeDatasetDetail(false);
      runPanel.hidden = true;
      syncRunRefresh();
      const status = Object.hasOwn(labels, data.status) ? data.status : "error";
      const items = Array.isArray(data.histories) ? data.histories.filter(value => value && typeof value === "object") : [];
      const rows = items.slice(0, visibleCount);

      breadcrumbs.hidden = true;
      historyBack.textContent = "‹ Histories";
      title.textContent = "Galaxy histories";
      histories.setAttribute("aria-label", "Galaxy histories");
      badge.dataset.state = status;
      badge.textContent = labels[status];
      instance.textContent = sourceLabel() || string(data.instance);
      instance.hidden = !instance.textContent;
      message.textContent = string(data.message) || (status === "not_configured"
        ? "Configure a Galaxy instance to view histories."
        : status === "connected" ? "No histories found." : "Galaxy histories are unavailable.");
      if (rows.length) message.textContent = "Showing " + rows.length + (rows.length < items.length ? " of " + items.length + " loaded" : "") + " histories" + (data.pagination?.has_more === true ? " · more available." : ".") + (toolsAvailable() ? " Select a history to browse its results." : "");
      if (initialized && !canCallTools) message.textContent += browsingUnavailable;
      histories.replaceChildren();

      for (const value of rows) {
        if (!value || typeof value !== "object") continue;
        const row = document.createElement("li");
        const summary = document.createElement("div");
        const name = document.createElement("h2");
        const state = document.createElement("p");
        const meta = document.createElement("div");
        summary.className = "summary";
        name.textContent = string(value.name) || "Untitled history";
        state.className = "state";
        state.textContent = stateLabel(value.state);
        state.dataset.state = string(value.state).toLowerCase();
        summary.append(name, state);
        meta.className = "meta";
        if (string(value.update_time)) {
          const updated = document.createElement("span");
          updated.textContent = "Updated " + string(value.update_time);
          meta.append(updated);
        }
        if (typeof value.count === "number" && Number.isFinite(value.count)) {
          const count = document.createElement("span");
          count.textContent = String(value.count) + " items";
          meta.append(count);
        }
        if (string(value.id)) {
          const button = document.createElement("button");
          button.className = "content-button";
          button.type = "button";
          button.disabled = !toolsAvailable();
          button.setAttribute("aria-label", "Open history " + name.textContent);
          button.append(summary, meta);
          button.addEventListener("click", () => openHistory(value));
          row.dataset.clickable = "true";
          row.append(button);
        } else row.append(summary, meta);
        histories.append(row);
      }

      canShowMore = rows.length < items.length || data.pagination?.has_more === true;
      showMore.textContent = "Load more";
      showMore.disabled = rows.length >= items.length && !toolsAvailable();
      updateListVisibility();
      publishView({ view: "histories", report_status: "not_open", visible_count: rows.length });
    }

    function contentKind(value) {
      const contentType = string(value.history_content_type || value.type).toLowerCase();
      const extension = string(value.extension || value.file_ext).toLowerCase();
      if (contentType.includes("collection")) return { format: "SET", label: "Dataset collection", tone: "report" };
      if (/fastq|fasta|bam|sam|vcf/.test(extension)) {
        const format = extension.startsWith("fastq") ? "FASTQ" : extension.startsWith("fasta") ? "FASTA" : extension.toUpperCase();
        return { format, label: "Sequencing data", tone: "data" };
      }
      if (extension === "html") return { format: "HTML", label: "Visual report", tone: "report" };
      if (/txt|tabular|csv|tsv/.test(extension)) return { format: extension === "tabular" ? "TABLE" : extension.toUpperCase(), label: "Raw result", tone: "raw" };
      return { format: extension ? extension.slice(0, 6).toUpperCase() : "DATA", label: "Dataset", tone: "data" };
    }

    function renderContents(data) {
      setHistoryLink(data);
      closeDatasetDetail(false);
      runPanel.hidden = true;
      syncRunRefresh();
      const success = data.success === true && Array.isArray(data.data);
      const items = success ? data.data.filter(value => value && typeof value === "object") : [];
      const rows = items.slice(0, visibleCount);
      const status = success ? "connected" : data.errorKind === "connection" ? "not_configured" : "error";

      breadcrumbs.hidden = !historyList && !currentRun;
      historyBack.textContent = currentRun ? "‹ Run status" : "‹ Histories";
      historyName.textContent = string(currentHistory?.name) || "History contents";
      title.textContent = data.view === "dataset" ? "Galaxy report" : currentRun ? "History results" : "History contents";
      histories.setAttribute("aria-label", "Galaxy history contents");
      badge.dataset.state = status;
      badge.textContent = success ? data.view === "dataset" ? "Report" : "Results" : labels[status];
      instance.textContent = sourceLabel() || "Galaxy results";
      instance.hidden = false;
      message.textContent = success
        ? data.search ? "Showing " + rows.length + " of " + items.length + " loaded matches. "
          + (data.search.complete === true ? "Search complete for the requested scope." : "Partial search; unsearched items may contain additional matches.")
          : rows.length === 0 ? firstOffset ? "No items on this page." : "No items in the requested history scope."
          : "Showing " + rows.length + (rows.length < items.length ? " of " + items.length + " loaded" : "") + " items"
            + (firstOffset ? " starting at item " + (firstOffset + 1) : "")
            + (data.pagination?.has_more === true ? " · more available." : ".")
        : string(data.message) || "Galaxy history contents are unavailable.";
      if (initialized && !canCallTools) message.textContent += browsingUnavailable;
      histories.replaceChildren();

      for (const value of rows) {
        if (!value || typeof value !== "object") continue;
        const descriptor = contentKind(value);
        const row = document.createElement("li");
        const kind = document.createElement("span");
        const summary = document.createElement("div");
        const name = document.createElement("h2");
        const detail = document.createElement("p");
        const meta = document.createElement("div");
        const state = document.createElement("span");
        const stateValue = string(value.state).toLowerCase() || "unknown";
        const extension = string(value.extension || value.file_ext).toLowerCase();
        const canOpen = stateValue === "ok" && string(value.id) && (readableExtensions.has(extension) || extension === "html");

        row.dataset.view = "content";
        kind.className = "kind";
        kind.dataset.kind = descriptor.tone;
        kind.textContent = descriptor.format;
        kind.setAttribute("aria-label", descriptor.label);
        summary.className = "summary";
        name.textContent = string(value.name) || "Untitled dataset";
        detail.className = "detail";
        detail.textContent = descriptor.label;
        meta.className = "meta";
        state.className = "status";
        state.dataset.state = stateValue === "ok" ? "ok" : ["error", "failed", "discarded"].includes(stateValue) ? "error" : "neutral";
        state.textContent = stateLabel(stateValue);
        summary.append(name, detail);
        meta.append(state);
        if (canOpen) {
          const view = document.createElement("span");
          const button = document.createElement("button");
          view.className = "view";
          view.textContent = "View ›";
          meta.append(view);
          button.className = "content-button";
          button.type = "button";
          button.disabled = !toolsAvailable();
          button.setAttribute("aria-label", "View contents of " + name.textContent);
          button.setAttribute("aria-expanded", "false");
          button.setAttribute("aria-controls", "dataset-detail");
          button.append(kind, summary, meta);
          button.addEventListener("click", () => openDataset(value, button));
          row.dataset.clickable = "true";
          row.append(button);
        } else {
          row.append(kind, summary, meta);
        }
        histories.append(row);
      }

      canShowMore = rows.length < items.length || (data.pagination?.has_more === true && !!string(currentHistory?.id));
      showMore.textContent = "Load more";
      showMore.disabled = rows.length >= items.length && !toolsAvailable();
      updateListVisibility();
      publishView({ view: "history_contents", history_id: currentHistory?.id, report_status: "not_open", visible_items: rows.map(item => ({ id: item.id, name: item.name })), loaded_count: items.length, has_more: data.pagination?.has_more === true });
    }

    function openSelectedDataset() {
      if (!directDataset || directOpenStarted || !toolsAvailable()) return;
      const button = histories.children[0]?.children[0];
      if (!button || button.disabled) return;
      directOpenStarted = true;
      void openDataset(directDataset, button);
    }

    async function openHistory(value) {
      if (!toolsAvailable()) return;
      localNavigation = true;
      const requestId = ++viewRequestId;
      currentHistory = value;
      currentContents = undefined;
      directDataset = undefined;
      visibleCount = CONTENT_PAGE_SIZE;
      firstOffset = 0;
      renderContents({ success: true, data: [] });
      message.textContent = "Loading this history's results…";
      histories.setAttribute("aria-busy", "true");
      sendSize();
      try {
        const result = await request("tools/call", { name: "get_history_contents", arguments: { historyId: string(value.id), limit: CONTENT_PAGE_SIZE, offset: 0 } });
        if (requestId !== viewRequestId) return;
        if (result?.isError || result?.structuredContent?.success !== true || !Array.isArray(result.structuredContent.data)) throw new Error("History unavailable");
        currentContents = result.structuredContent;
        renderContents(currentContents);
      } catch {
        if (requestId !== viewRequestId) return;
        renderContents({ success: false, message: "This history could not be loaded. " + (currentRun ? "Return to Run status" : "Return to Histories") + " and try again." });
      } finally {
        if (requestId === viewRequestId) {
          histories.removeAttribute("aria-busy");
          sendSize();
        }
      }
    }

    async function loadMore() {
      if (closed || showMore.disabled) return;
      localNavigation = true;
      if (!currentContents) {
        if (!historyList) return;
        if (visibleCount < historyList.histories.length) {
          visibleCount = Math.min(visibleCount + CONTENT_PAGE_SIZE, historyList.histories.length);
          historyVisibleCount = visibleCount;
          renderHistories(historyList);
          sendSize();
          return;
        }
        const offset = historyList.pagination?.next_offset;
        if (!toolsAvailable() || historyList.pagination?.has_more !== true || !Number.isSafeInteger(offset) || offset < 0) return;
        const requestId = viewRequestId;
        const previous = historyList;
        showMore.disabled = true;
        showMore.textContent = "Loading…";
        try {
          const result = await request("tools/call", { name: "get_histories", arguments: { limit: CONTENT_PAGE_SIZE, offset } });
          if (requestId !== viewRequestId) return;
          const page = result?.structuredContent;
          if (result?.isError || page?.status !== "connected" || !Array.isArray(page.histories) || page.pagination?.offset !== offset) throw new Error("Histories page unavailable");
          historyList = { ...page, histories: [...previous.histories, ...page.histories] };
          visibleCount = Math.min(visibleCount + CONTENT_PAGE_SIZE, historyList.histories.length);
          historyVisibleCount = visibleCount;
          renderHistories(historyList);
        } catch {
          if (requestId !== viewRequestId) return;
          message.textContent = "More histories could not be loaded. The displayed histories are unchanged.";
          showMore.textContent = "Retry loading more";
        } finally {
          if (requestId === viewRequestId) {
            showMore.disabled = false;
            if (showMore.textContent === "Loading…") showMore.textContent = "Load more";
            sendSize();
          }
        }
        return;
      }
      if (visibleCount < currentContents.data.length) {
        visibleCount = Math.min(visibleCount + CONTENT_PAGE_SIZE, currentContents.data.length);
        renderContents(currentContents);
        sendSize();
        return;
      }
      const pagination = currentContents.pagination;
      if (!toolsAvailable() || pagination?.has_more !== true || !string(currentHistory?.id)) return;
      const offset = pagination.next_offset ?? pagination.offset + pagination.returned;
      if (!Number.isSafeInteger(offset) || offset < 0) return;
      const requestId = viewRequestId;
      const detailId = detailRequestId;
      const previous = currentContents;
      showMore.disabled = true;
      showMore.textContent = "Loading…";
      try {
        const result = await request("tools/call", { name: "get_history_contents", arguments: { ...currentContents.filters, historyId: string(currentHistory.id), limit: CONTENT_PAGE_SIZE, offset } });
        if (requestId !== viewRequestId || detailId !== detailRequestId) return;
        const page = result?.structuredContent;
        if (result?.isError || page?.success !== true || !Array.isArray(page.data)) throw new Error("Page unavailable");
        currentContents = { ...page, data: [...previous.data, ...page.data] };
        visibleCount = Math.min(visibleCount + CONTENT_PAGE_SIZE, currentContents.data.length);
        renderContents(currentContents);
      } catch {
        if (requestId !== viewRequestId || detailId !== detailRequestId) return;
        message.textContent = "More results could not be loaded. The displayed results are unchanged.";
        showMore.textContent = "Retry loading more";
      } finally {
        if (requestId === viewRequestId) {
          showMore.disabled = false;
          if (showMore.textContent === "Loading…") showMore.textContent = "Load more";
          sendSize();
        }
      }
    }

    historyBack.addEventListener("click", () => {
      localNavigation = true;
      viewRequestId += 1;
      currentHistory = undefined;
      currentContents = undefined;
      visibleCount = historyVisibleCount;
      histories.removeAttribute("aria-busy");
      if (currentRun) {
        renderRun();
        runResults.focus();
      } else renderHistories(historyList);
      sendSize();
    });
    showMore.addEventListener("click", loadMore);
    showLess.addEventListener("click", () => {
      if (closed || showLess.hidden) return;
      localNavigation = true;
      viewRequestId += 1;
      visibleCount = Math.max(CONTENT_PAGE_SIZE, histories.childElementCount - CONTENT_PAGE_SIZE);
      if (currentContents) renderContents(currentContents);
      else {
        historyVisibleCount = visibleCount;
        renderHistories(historyList);
      }
      if (showLess.hidden) {
        if (!showMore.hidden) showMore.focus();
        else histories.children[0]?.children[0]?.focus();
      }
      sendSize();
    });

    function closeDatasetDetail(returnFocus) {
      detailRequestId += 1;
      setReportLink();
      datasetDetail.hidden = true;
      datasetDetail.removeAttribute("aria-busy");
      detailBody.replaceChildren();
      updateListVisibility();
      if (activeContentButton) {
        activeContentButton.disabled = false;
        activeContentButton.setAttribute("aria-expanded", "false");
        if (returnFocus) activeContentButton.focus();
      }
      activeContentButton = undefined;
      if (returnFocus) publishView({ view: "history_contents", history_id: currentHistory?.id, report_status: "not_open", visible_count: histories.childElementCount });
      sendSize();
    }

    function parseFastqc(text) {
      let version = "";
      let inBasicStatistics = false;
      const statistics = [];
      const modules = [];

      for (const line of text.split(/\\r?\\n/)) {
        const versionMatch = /^##FastQC\\t(.+)$/.exec(line);
        const moduleMatch = /^>>(.+)\\t(pass|warn|fail)$/.exec(line);
        if (versionMatch) version = versionMatch[1];
        if (moduleMatch) {
          modules.push({ name: moduleMatch[1], status: moduleMatch[2] });
          inBasicStatistics = moduleMatch[1] === "Basic Statistics";
          continue;
        }
        if (line === ">>END_MODULE") {
          inBasicStatistics = false;
          continue;
        }
        if (inBasicStatistics && line && !line.startsWith("#")) {
          const parts = line.split("\\t");
          const label = parts.shift();
          if (label && parts.length > 0) statistics.push([label, parts.join(" ")]);
        }
      }
      return { version, statistics, modules };
    }

    function renderDatasetText(data) {
      const text = string(data.text);
      const parsed = parseFastqc(text);
      detailBody.replaceChildren();
      detailTitle.textContent = string(data.name) || "Dataset contents";
      detailMessage.textContent = (parsed.version ? "FastQC " + parsed.version : string(data.extension).toUpperCase() || "Text result")
        + " · " + String(text.length) + " characters"
        + (data.truncated === true ? " · truncated" : "");

      if (parsed.modules.length > 0) {
        const scores = document.createElement("div");
        scores.className = "scores";
        for (const status of ["pass", "warn", "fail"]) {
          const score = document.createElement("div");
          const count = document.createElement("strong");
          const label = document.createElement("span");
          score.className = "score";
          score.dataset.state = status;
          count.textContent = String(parsed.modules.filter(module => module.status === status).length);
          label.textContent = status;
          score.append(count, label);
          scores.append(score);
        }
        detailBody.append(scores);

        if (parsed.statistics.length > 0) {
          const heading = document.createElement("p");
          const statistics = document.createElement("dl");
          heading.className = "section-title";
          heading.textContent = "Basic Statistics";
          statistics.className = "statistics";
          for (const [label, value] of parsed.statistics) {
            const stat = document.createElement("div");
            const term = document.createElement("dt");
            const description = document.createElement("dd");
            stat.className = "stat";
            term.textContent = label;
            description.textContent = value;
            stat.append(term, description);
            statistics.append(stat);
          }
          detailBody.append(heading, statistics);
        }

        const moduleHeading = document.createElement("p");
        const modules = document.createElement("div");
        moduleHeading.className = "section-title";
        moduleHeading.textContent = "FastQC modules";
        modules.className = "modules";
        modules.setAttribute("role", "list");
        for (const module of parsed.modules) {
          const row = document.createElement("div");
          const name = document.createElement("span");
          const status = document.createElement("span");
          row.className = "module";
          row.setAttribute("role", "listitem");
          name.textContent = module.name;
          status.className = "module-status";
          status.dataset.state = module.status;
          status.textContent = module.status;
          row.append(name, status);
          modules.append(row);
        }
        const caveat = document.createElement("p");
        caveat.className = "caveat";
        caveat.textContent = "FastQC flags are signals; interpret them using the library type and sample size.";
        detailBody.append(moduleHeading, modules, caveat);
      }

      const raw = document.createElement("details");
      const rawLabel = document.createElement("summary");
      const rawText = document.createElement("pre");
      rawLabel.textContent = "Raw text · scroll sideways";
      rawText.textContent = text;
      rawText.tabIndex = 0;
      rawText.setAttribute("role", "region");
      rawText.setAttribute("aria-label", "Raw dataset text; scroll horizontally for long lines");
      raw.open = parsed.modules.length === 0;
      raw.addEventListener("toggle", sendSize);
      raw.append(rawLabel, rawText);
      detailBody.append(raw);
    }

    function reportPreview(html) {
      const source = new DOMParser().parseFromString(html, "text/html");
      const preview = document.createElement("div");
      preview.className = "report-preview";
      const allowed = new Set("div span p h1 h2 h3 h4 h5 h6 table caption thead tbody tfoot tr th td ul ol li dl dt dd strong b em i pre code blockquote br hr".split(" "));
      const blocked = new Set("script style noscript iframe object embed form input button textarea select base link meta template svg math canvas audio video".split(" "));
      let visited = 0;
      let limited = false;
      // Bounded static projection, never adopt source nodes, attributes, CSS or executable markup.
      function append(node, parent, depth) {
        if (++visited > 10000 || depth > 60) { limited = true; return; }
        if (node.nodeType === 3) { parent.append(document.createTextNode(node.textContent || "")); return; }
        if (node.nodeType !== 1 || node.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
        const tag = node.tagName.toLowerCase();
        if (blocked.has(tag)) return;
        if (tag === "img") {
          const src = node.getAttribute("src") || "";
          if (/^data:image\\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/\\r\\n]*={0,2}$/i.test(src)) {
            const image = document.createElement("img");
            image.setAttribute("src", src);
            image.setAttribute("alt", node.getAttribute("alt") || "Report image");
            image.addEventListener("load", sendSize, { once: true });
            parent.append(image);
          } else if (node.getAttribute("alt")) parent.append(document.createTextNode(node.getAttribute("alt")));
          return;
        }
        const target = allowed.has(tag) ? document.createElement(tag) : parent;
        if (target !== parent) {
          if (tag === "td" || tag === "th") for (const name of ["colspan", "rowspan"]) {
            const value = node.getAttribute(name) || "";
            if (/^[1-9][0-9]?$/.test(value)) target.setAttribute(name, value);
          }
          parent.append(target);
        }
        for (const child of node.childNodes) {
          if (visited >= 10000) { limited = true; break; }
          append(child, target, depth + 1);
        }
      }
      append(source.body, preview, 0);
      if (!preview.textContent.trim() && !preview.querySelector("img")) preview.textContent = "No static report content is available. Open the original report in Galaxy.";
      return { preview, limited };
    }

    function renderDatasetHtml(data, html) {
      detailBody.replaceChildren();
      detailTitle.textContent = string(data.name) || "HTML report";
      const { preview, limited } = reportPreview(html);
      detailMessage.textContent = "Static report preview · " + String(data.characters_returned || html.length) + " characters"
        + (data.truncated === true ? " · truncated" : "");
      const note = document.createElement("p");
      const scroller = document.createElement("div");
      note.className = "report-note";
      note.textContent = "Static text, tables and embedded images. Scripts, original styling and external assets are omitted; open the original for the full report."
        + (limited ? " Preview limit reached; some content is omitted." : "");
      scroller.className = "report-scroll";
      scroller.tabIndex = 0;
      scroller.setAttribute("role", "region");
      scroller.setAttribute("aria-label", "Static report preview; scroll horizontally for wide tables and images");
      scroller.append(preview);
      detailBody.append(note, scroller);
    }

    async function openDataset(value, button) {
      if (!toolsAvailable() || button.disabled) return;
      localNavigation = true;
      const requestId = ++detailRequestId;
      setReportLink();
      if (activeContentButton && activeContentButton !== button) {
        activeContentButton.disabled = false;
        activeContentButton.setAttribute("aria-expanded", "false");
      }
      activeContentButton = button;
      button.disabled = true;
      button.setAttribute("aria-expanded", "true");
      datasetDetail.hidden = false;
      datasetDetail.setAttribute("aria-busy", "true");
      detailTitle.textContent = string(value.name) || "Dataset contents";
      detailMessage.textContent = "Loading real Galaxy data…";
      const reportContext = { view: "report", dataset_id: string(value.id), name: string(value.name) };
      publishView({ ...reportContext, report_status: "loading", display_verified: false });
      detailBody.replaceChildren();
      updateListVisibility();
      detailClose.focus();
      sendSize();

      try {
        const html = string(value.extension || value.file_ext).toLowerCase() === "html";
        const result = await request("tools/call", {
          name: html ? "get_dataset_html" : "get_dataset_text",
          arguments: { datasetId: string(value.id) },
        });
        if (requestId !== detailRequestId) return;
        if (result?.isError || !result?.structuredContent) {
          throw new Error("Dataset content was unavailable");
        }
        if (html && typeof result?._meta?.html === "string") {
          setReportLink(result.structuredContent);
          renderDatasetHtml(result.structuredContent, result._meta.html);
          publishView({ ...reportContext, report_status: "content_loaded", presentation: "static_report_preview", display_verified: false, report_content_in_feedback: false });
        } else if (!html && typeof result.structuredContent.text === "string") {
          renderDatasetText(result.structuredContent);
          publishView({ ...reportContext, report_status: "text_view_ready", characters_returned: result.structuredContent.text.length, truncated: result.structuredContent.truncated === true });
        } else {
          throw new Error("Dataset text was unavailable");
        }
      } catch {
        if (requestId !== detailRequestId) return;
        detailMessage.textContent = "This report could not be loaded. Return to Results and try again.";
        publishView({ ...reportContext, report_status: "load_failed", display_verified: false });
      } finally {
        button.disabled = false;
        if (requestId === detailRequestId) {
          datasetDetail.removeAttribute("aria-busy");
          sendSize();
        }
      }
    }

    detailClose.addEventListener("click", () => closeDatasetDetail(true));
    addEventListener("resize", sendSize);

    function sourceLabel() {
      return sourceGalaxy ? sourceGalaxy.instance + " · " + new URL(sourceGalaxy.url).host : "";
    }

    function render(candidate) {
      if (closed) return;
      const data = candidate?.structuredContent ?? candidate;
      if (!data || typeof data !== "object") return;
      const incomingViewId = string(data.presentation?.view_id);
      if (localNavigation && (!incomingViewId || incomingViewId === sourceViewId)) return;
      if (incomingViewId && incomingViewId !== sourceViewId && seenViewIds.has(incomingViewId)) return;
      if (incomingViewId) seenViewIds.add(incomingViewId);
      sourceViewId = incomingViewId;
      sourceGalaxy = undefined;
      try {
        const url = new URL(data.galaxy?.url);
        if (string(data.galaxy?.instance) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
          sourceGalaxy = { instance: data.galaxy.instance, url: data.galaxy.url };
        }
      } catch { /* Saved single-site results may not carry an explicit source. */ }
      localNavigation = false;
      visibleCount = CONTENT_PAGE_SIZE;
      viewRequestId += 1;
      directDataset = data.view === "dataset" && data.success === true ? data.data?.[0] : undefined;
      directOpenStarted = false;
      if (data.run && typeof data.run === "object") {
        currentRun = data.run;
        runRefreshing = false;
        runUnconfirmed = data.success !== true;
        currentHistory = undefined;
        currentContents = undefined;
        historyList = undefined;
        renderRun();
      } else if (Object.hasOwn(data, "success")) {
        visibleCount = CONTENT_PAGE_SIZE;
        currentRun = undefined;
        historyList = undefined;
        currentContents = data;
        currentHistory = { id: string(data.history_id) };
        firstOffset = Number.isSafeInteger(data.pagination?.offset) ? data.pagination.offset : 0;
        renderContents(data);
        openSelectedDataset();
      } else {
        currentRun = undefined;
        historyList = data;
        historyVisibleCount = CONTENT_PAGE_SIZE;
        currentContents = undefined;
        currentHistory = undefined;
        renderHistories(data);
      }
      sendSize();
    }

    addEventListener("message", event => {
      if (event.source !== window.parent) return;
      const rpc = event.data;
      if (!rpc || rpc.jsonrpc !== "2.0") return;
      if (rpc.method === "ui/resource-teardown" && rpc.id !== undefined) {
        closeView();
        post({ jsonrpc: "2.0", id: rpc.id, result: {} });
        return;
      }
      if (closed) return;
      if (rpc.method === undefined && rpc.id !== undefined && pending.has(rpc.id)) {
        const handler = pending.get(rpc.id);
        pending.delete(rpc.id);
        clearTimeout(handler.timer);
        if (rpc.error) handler.reject(rpc.error);
        else handler.resolve(rpc.result);
        return;
      }
      if (rpc?.jsonrpc === "2.0" && rpc?.method === "ui/notifications/tool-result") {
        render(rpc.params?.structuredContent ?? rpc.params);
      }
      if (rpc.method === "ui/notifications/host-context-changed") applyTheme(rpc.params?.theme);
    });

    function closeView() {
      closed = true;
      initialized = false;
      clearTimeout(runTimer);
      cardObserver?.disconnect();
      viewRequestId += 1;
      detailRequestId += 1;
      for (const handler of pending.values()) {
        clearTimeout(handler.timer);
        handler.reject(new Error("Galaxy view closed"));
      }
      pending.clear();
    }
    addEventListener("pagehide", event => {
      if (!event.persisted) return closeView();
      suspended = true;
      syncRunRefresh();
    });
    addEventListener("pageshow", event => {
      if (!event.persisted || closed) return;
      suspended = false;
      syncRunRefresh();
      sendSize();
    });
    document.addEventListener("visibilitychange", syncRunRefresh);
    const cardObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting);
      if (cardVisible === visible) return;
      cardVisible = visible;
      syncRunRefresh();
    }) : undefined;
    cardObserver?.observe(document.documentElement);

    addEventListener("openai:set_globals", event => {
      const globals = event.detail?.globals;
      applyTheme(globals?.theme);
      if (globals && Object.hasOwn(globals, "toolOutput")) render(globals.toolOutput);
    }, { passive: true });

    function applyTheme(theme) {
      if (theme === "light" || theme === "dark") document.documentElement.style.colorScheme = theme;
    }

    applyTheme(window.openai?.theme);
    const initial = window.openai?.toolOutput;
    if (initial) render(initial.structuredContent ?? initial);
    async function initializeView() {
      if (closed || initialized || initializing) return;
      initializing = true;
      viewReconnect.disabled = true;
      try {
        const result = await request("ui/initialize", {
          appInfo: { name: "Galaxy results", version: "1.9.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        }, 15000);
        if (closed) return;
        initialized = true;
        viewReconnect.hidden = true;
        if (result?.hostCapabilities !== undefined) canCallTools = !!result.hostCapabilities?.serverTools;
        canUpdateContext = !!result?.hostCapabilities?.updateModelContext;
        canOpenLinks = !!result?.hostCapabilities?.openLinks;
        applyTheme(result?.hostContext?.theme);
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
        if (!datasetDetail.hidden && localNavigation) {
          if (viewContext) publishView(viewContext);
        } else if (currentRun && !currentHistory) renderRun();
        else if (currentContents) renderContents(currentContents);
        else if (historyList) renderHistories(historyList);
        else {
          badge.dataset.state = "neutral";
          badge.textContent = "Waiting";
          message.textContent = "Waiting for Galaxy results…";
        }
        openSelectedDataset();
      } catch {
        if (closed) return;
        viewReconnect.hidden = false;
        if (currentRun && !currentHistory) {
          runUnconfirmed = true;
          renderRun();
        } else {
          badge.dataset.state = "error";
          badge.textContent = "Unavailable";
          message.textContent = "The host did not initialize this Galaxy view. Existing results remain available; reconnect this view to try again.";
        }
      } finally {
        initializing = false;
        viewReconnect.disabled = closed;
        sendSize();
      }
    }
    viewReconnect.addEventListener("click", initializeView);
    void initializeView();
  </script>
</body>
</html>`;

export function registerHistorySummaryResource(server: McpServer, domain?: string): void {
  const metadata = {
    // Host-specific origins are not portable. Claude uses its default isolated origin.
    ...(domain && { "openai/widgetDomain": domain }),
    ui: {
      prefersBorder: true,
      csp: {
        connectDomains: [],
        resourceDomains: [],
      },
    },
  };
  for (const [index, resourceUri] of [...LEGACY_HISTORY_SUMMARY_URIS, HISTORY_SUMMARY_URI].entries()) {
    server.registerResource(
      `galaxy-history-v${index + 1}`,
      resourceUri,
      { title: "Galaxy runs, histories and results", mimeType: MIME_TYPE, _meta: metadata },
      (uri) => ({
        contents: [{ uri: uri.href, mimeType: MIME_TYPE, text: HTML, _meta: metadata }],
      }),
    );
  }
}
