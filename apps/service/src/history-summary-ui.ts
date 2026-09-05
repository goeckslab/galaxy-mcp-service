import type { McpServer } from "@modelcontextprotocol/server";

export const HISTORY_SUMMARY_URI = "ui://galaxy/history-summary-v10.html";

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
] as const;

const MIME_TYPE = "text/html;profile=mcp-app";
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
    .content-button:disabled { cursor: progress; opacity: .66; }
    .view { color: var(--accent); font-weight: 650; }
    .breadcrumbs { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; color: var(--secondary); font-size: .76rem; }
    .breadcrumbs span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .more-button { display: block; margin: 14px auto 0; }
    .dataset-detail { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
    .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .detail-header > div { min-width: 0; }
    .dataset-detail h2 { white-space: normal; }
    .close-button { min-height: 32px; padding: 5px 10px; border: 0; border-radius: 999px; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); font: inherit; font-size: .76rem; font-weight: 650; cursor: pointer; }
    .close-button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .close-button:disabled { color: var(--secondary); background: var(--row); cursor: default; }
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
    .sandbox-note { margin-top: 12px; color: var(--secondary); font-size: .72rem; line-height: 1.4; }
    .report-scroll { max-width: 100%; margin-top: 10px; overflow-x: scroll; overscroll-behavior-inline: contain; scrollbar-gutter: stable; border: 1px solid var(--line); border-radius: 14px; background: white; }
    .report-frame { display: block; width: max(100%, 840px); height: clamp(420px, 72vw, 620px); margin: 0; border: 0; background: white; }
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
      <div>
        <h1 id="title">Galaxy histories</h1>
        <p id="instance" class="instance" hidden></p>
      </div>
      <span id="badge" class="badge">Waiting</span>
    </header>
    <p id="message" class="message" role="status" aria-live="polite">Waiting for Galaxy…</p>
    <section id="run-panel" aria-label="Analysis run status" hidden>
      <p id="run-checked" class="detail"></p>
      <p id="run-warning" class="run-warning" role="status" aria-live="polite" hidden></p>
      <dl id="run-jobs" class="statistics" aria-label="Job counts" hidden></dl>
      <div class="run-actions">
        <button id="run-refresh" class="close-button" type="button">Refresh status</button>
        <button id="run-results" class="close-button" type="button">View history results</button>
      </div>
      <p id="run-results-note" class="caveat">History results may include inputs and outputs from other runs.</p>
    </section>
    <ul id="histories" aria-label="Galaxy histories" hidden></ul>
    <button id="show-more" class="close-button more-button" type="button" hidden>Show more</button>
    <section id="dataset-detail" class="dataset-detail" aria-labelledby="detail-title" hidden>
      <div class="detail-header">
        <div>
          <h2 id="detail-title">Dataset contents</h2>
          <p id="detail-message" class="detail" role="status" aria-live="polite"></p>
        </div>
        <button id="detail-close" class="close-button" type="button">‹ Results</button>
      </div>
      <div id="detail-body"></div>
    </section>
  </main>
  <script>
    const badge = document.getElementById("badge");
    const title = document.getElementById("title");
    const instance = document.getElementById("instance");
    const message = document.getElementById("message");
    const runPanel = document.getElementById("run-panel");
    const runChecked = document.getElementById("run-checked");
    const runWarning = document.getElementById("run-warning");
    const runJobs = document.getElementById("run-jobs");
    const runRefresh = document.getElementById("run-refresh");
    const runResults = document.getElementById("run-results");
    const runResultsNote = document.getElementById("run-results-note");
    const histories = document.getElementById("histories");
    const breadcrumbs = document.getElementById("breadcrumbs");
    const historyBack = document.getElementById("history-back");
    const historyName = document.getElementById("history-name");
    const showMore = document.getElementById("show-more");
    const datasetDetail = document.getElementById("dataset-detail");
    const detailTitle = document.getElementById("detail-title");
    const detailMessage = document.getElementById("detail-message");
    const detailBody = document.getElementById("detail-body");
    const detailClose = document.getElementById("detail-close");
    const labels = { connected: "Connected", not_configured: "Not configured", error: "Error" };
    const string = value => typeof value === "string" ? value : "";
    const stateLabels = { ok: "Ready", new: "Preparing", upload: "Uploading", queued: "Queued", running: "Running", waiting: "Waiting", paused: "Paused", error: "Failed", failed: "Failed", discarded: "Discarded", deleted: "Deleted", empty: "Empty", setting_metadata: "Preparing metadata" };
    const stateLabel = value => Object.hasOwn(stateLabels, string(value).toLowerCase()) ? stateLabels[string(value).toLowerCase()] : "Status unavailable";
    const readableExtensions = new Set(["txt", "tabular", "csv", "tsv"]);
    const pending = new Map();
    let nextRequestId = 1;
    let detailRequestId = 0;
    let activeContentButton;
    let initialized = false;
    let localNavigation = false;
    let viewRequestId = 0;
    let historyList;
    let currentHistory;
    let currentContents;
    let visibleCount = 20;
    let historyVisibleCount = 20;
    let firstOffset = 0;
    let canShowMore = false;
    let currentRun;
    let runRefreshing = false;
    let runUnconfirmed = false;
    const runStateLabels = { accepted: "Submitted", queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled", empty: "No analysis ran", unknown: "Status unknown" };
    const runMessages = { accepted: "Galaxy accepted this analysis. Refresh to check its progress.", queued: "Waiting for Galaxy to start the jobs.", running: "Galaxy is processing this analysis.", completed: "Processing has finished. Review the results to assess their quality.", failed: "This analysis failed. Review the available details and any partial results.", cancelled: "This analysis was cancelled. Existing results may still be available.", empty: "No analysis ran: no jobs were created, or every job was skipped.", unknown: "The current state could not be confirmed." };

    function post(message) {
      window.parent.postMessage(message, "*");
    }

    function request(method, params, timeoutMs = 45000) {
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Galaxy view request timed out"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
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

    function updateListVisibility() {
      histories.hidden = !datasetDetail.hidden || histories.childElementCount === 0;
      message.hidden = !datasetDetail.hidden;
      showMore.hidden = !datasetDetail.hidden || !canShowMore;
    }

    function renderRun() {
      closeDatasetDetail(false);
      runPanel.hidden = false;
      runPanel.setAttribute("aria-busy", String(runRefreshing));
      breadcrumbs.hidden = true;
      histories.replaceChildren();
      canShowMore = false;
      updateListVisibility();
      const state = Object.hasOwn(runStateLabels, currentRun.state) ? currentRun.state : "unknown";
      title.textContent = string(currentRun.name) || (currentRun.kind === "workflow" ? "Galaxy workflow" : "Galaxy tool run");
      instance.textContent = currentRun.kind === "workflow" ? "Workflow run" : "Tool run";
      instance.hidden = false;
      badge.dataset.state = runUnconfirmed || state === "unknown" ? "unknown" : state === "completed" ? "connected" : state === "failed" ? "error" : state === "running" ? "running" : "neutral";
      badge.textContent = runUnconfirmed ? "Unconfirmed" : runStateLabels[state];
      message.textContent = string(currentRun.message) || runMessages[state];
      const checked = new Date(string(currentRun.checked_at));
      runChecked.textContent = Number.isNaN(checked.getTime()) ? "No confirmed status check yet." : "Last checked " + checked.toLocaleString();
      runWarning.hidden = !runUnconfirmed;
      runWarning.textContent = "The current status is unconfirmed. " + (state === "unknown" ? "Refresh status to try again." : "Last known status: " + runStateLabels[state] + ". Refresh status to try again.");
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
      runRefresh.disabled = runRefreshing || !string(currentRun.id) || !["tool", "workflow"].includes(currentRun.kind);
      runRefresh.textContent = runRefreshing ? "Checking…" : runUnconfirmed ? "Retry status check" : "Refresh status";
      runResults.disabled = !string(currentRun.history_id);
      runResultsNote.textContent = runResults.disabled ? "History results are not available for this run yet." : "History results may include inputs and outputs from other runs.";
    }

    async function refreshRun() {
      if (runRefreshing || runRefresh.disabled || !currentRun) return;
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
        if (requestId === viewRequestId) {
          runRefreshing = false;
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
      closeDatasetDetail(false);
      runPanel.hidden = true;
      const status = Object.hasOwn(labels, data.status) ? data.status : "error";
      const items = Array.isArray(data.histories) ? data.histories.filter(value => value && typeof value === "object") : [];
      const rows = items.slice(0, visibleCount);

      breadcrumbs.hidden = true;
      historyBack.textContent = "‹ Histories";
      title.textContent = "Galaxy histories";
      histories.setAttribute("aria-label", "Galaxy histories");
      badge.dataset.state = status;
      badge.textContent = labels[status];
      instance.textContent = string(data.instance);
      instance.hidden = !instance.textContent;
      message.textContent = string(data.message) || (status === "not_configured"
        ? "Configure a Galaxy instance to view histories."
        : status === "connected" ? "No histories found." : "Galaxy histories are unavailable.");
      if (rows.length) message.textContent = "Showing " + rows.length + " of " + items.length + " returned histories. Select a history to browse its results.";
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
          button.setAttribute("aria-label", "Open history " + name.textContent);
          button.append(summary, meta);
          button.addEventListener("click", () => openHistory(value));
          row.dataset.clickable = "true";
          row.append(button);
        } else row.append(summary, meta);
        histories.append(row);
      }

      canShowMore = rows.length < items.length;
      showMore.textContent = "Show more histories";
      showMore.disabled = false;
      updateListVisibility();
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
      closeDatasetDetail(false);
      runPanel.hidden = true;
      const success = data.success === true && Array.isArray(data.data);
      const items = success ? data.data.filter(value => value && typeof value === "object") : [];
      const rows = items.slice(0, visibleCount);
      const status = success ? "connected" : data.errorKind === "connection" ? "not_configured" : "error";

      breadcrumbs.hidden = !historyList && !currentRun;
      historyBack.textContent = currentRun ? "‹ Run status" : "‹ Histories";
      historyName.textContent = string(currentHistory?.name) || "History contents";
      title.textContent = currentRun ? "History results" : "History contents";
      histories.setAttribute("aria-label", "Galaxy history contents");
      badge.dataset.state = status;
      badge.textContent = success ? "Results" : labels[status];
      instance.textContent = "Galaxy results";
      instance.hidden = false;
      message.textContent = success
        ? rows.length === 0 ? firstOffset ? "No items on this page." : "This history is empty."
          : "Showing " + rows.length + (rows.length < items.length ? " of " + items.length + " loaded" : "") + " items"
            + (firstOffset ? " starting at item " + (firstOffset + 1) : "")
            + (data.pagination?.has_more === true ? " · more available." : ".")
        : string(data.message) || "Galaxy history contents are unavailable.";
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
      showMore.textContent = rows.length < items.length ? "Show more results" : "Load more results";
      showMore.disabled = false;
      updateListVisibility();
    }

    async function openHistory(value) {
      localNavigation = true;
      const requestId = ++viewRequestId;
      runRefreshing = false;
      currentHistory = value;
      currentContents = undefined;
      visibleCount = 20;
      firstOffset = 0;
      renderContents({ success: true, data: [] });
      message.textContent = "Loading this history's results…";
      histories.setAttribute("aria-busy", "true");
      sendSize();
      try {
        const result = await request("tools/call", { name: "get_history_contents", arguments: { historyId: string(value.id), limit: 20, offset: 0 } });
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
      localNavigation = true;
      if (!currentContents) {
        visibleCount += 20;
        historyVisibleCount = visibleCount;
        renderHistories(historyList);
        sendSize();
        return;
      }
      if (visibleCount < currentContents.data.length) {
        visibleCount += 20;
        renderContents(currentContents);
        sendSize();
        return;
      }
      const pagination = currentContents.pagination;
      if (pagination?.has_more !== true || !string(currentHistory?.id)) return;
      const offset = pagination.next_offset ?? pagination.offset + pagination.returned;
      if (!Number.isSafeInteger(offset) || offset < 0) return;
      const requestId = viewRequestId;
      const previous = currentContents;
      showMore.disabled = true;
      showMore.textContent = "Loading…";
      try {
        const result = await request("tools/call", { name: "get_history_contents", arguments: { historyId: string(currentHistory.id), limit: 20, offset } });
        if (requestId !== viewRequestId) return;
        const page = result?.structuredContent;
        if (result?.isError || page?.success !== true || !Array.isArray(page.data)) throw new Error("Page unavailable");
        currentContents = { ...page, data: [...previous.data, ...page.data] };
        visibleCount += 20;
        renderContents(currentContents);
      } catch {
        if (requestId !== viewRequestId) return;
        message.textContent = "More results could not be loaded. The displayed results are unchanged.";
        showMore.textContent = "Retry loading more";
      } finally {
        if (requestId === viewRequestId) {
          showMore.disabled = false;
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

    function closeDatasetDetail(returnFocus) {
      detailRequestId += 1;
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

    function sandboxHtml(html) {
      const source = new DOMParser().parseFromString(html, "text/html");
      source.querySelectorAll("script,noscript,iframe,object,embed,form,input,button,textarea,select,base,link,meta[http-equiv],animate,animateMotion,animateTransform,set,discard")
        .forEach(element => element.remove());
      const urlAttributes = new Set(["href", "xlink:href", "xml:base", "action", "formaction", "srcset", "ping", "data", "poster", "background", "target", "download"]);
      for (const element of source.querySelectorAll("*")) {
        for (const attribute of Array.from(element.attributes)) {
          const name = attribute.name.toLowerCase();
          if ((name === "href" || name === "xlink:href") && /^#[^\\u0000-\\u0020\\u007f]*$/.test(attribute.value)) {
            // Fragment navigation in srcdoc otherwise inherits the parent page's URL.
            if (element.tagName.toLowerCase() === "a") element.setAttribute(attribute.name, "about:srcdoc" + attribute.value);
            continue;
          }
          if (name.startsWith("on") || urlAttributes.has(name)) element.removeAttribute(attribute.name);
          if (name === "src" && !(element.tagName === "IMG" && /^data:image\\/(?:png|gif|jpe?g|webp);base64,/i.test(attribute.value))) {
            element.removeAttribute(attribute.name);
          }
        }
      }
      const policy = source.createElement("meta");
      policy.setAttribute("http-equiv", "Content-Security-Policy");
      policy.setAttribute("content", "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'");
      source.head.prepend(policy);
      return "<!doctype html>\\n" + source.documentElement.outerHTML;
    }

    function renderDatasetHtml(data, html) {
      detailBody.replaceChildren();
      detailTitle.textContent = string(data.name) || "HTML report";
      detailMessage.textContent = "Sandboxed HTML · " + String(data.characters_returned || html.length) + " characters"
        + (data.truncated === true ? " · truncated" : "");
      const note = document.createElement("p");
      const scroller = document.createElement("div");
      const frame = document.createElement("iframe");
      note.className = "sandbox-note";
      note.textContent = "Sandboxed for safety. Scroll horizontally to inspect wide reports.";
      scroller.className = "report-scroll";
      scroller.tabIndex = 0;
      scroller.setAttribute("role", "region");
      scroller.setAttribute("aria-label", "HTML report; scroll horizontally to inspect wide content");
      frame.className = "report-frame";
      frame.title = string(data.name) || "Galaxy HTML report";
      frame.setAttribute("sandbox", "");
      frame.referrerPolicy = "no-referrer";
      frame.srcdoc = sandboxHtml(html);
      frame.addEventListener("load", sendSize, { once: true });
      scroller.append(frame);
      detailBody.append(note, scroller);
    }

    async function openDataset(value, button) {
      localNavigation = true;
      const requestId = ++detailRequestId;
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
          renderDatasetHtml(result.structuredContent, result._meta.html);
        } else if (!html && typeof result.structuredContent.text === "string") {
          renderDatasetText(result.structuredContent);
        } else {
          throw new Error("Dataset text was unavailable");
        }
      } catch {
        if (requestId !== detailRequestId) return;
        detailMessage.textContent = "Galaxy could not load this report. Return to Results and try again.";
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

    function render(candidate) {
      if (localNavigation) return;
      const data = candidate?.structuredContent ?? candidate;
      if (!data || typeof data !== "object") return;
      visibleCount = 20;
      viewRequestId += 1;
      if (data.run && typeof data.run === "object") {
        currentRun = data.run;
        runRefreshing = false;
        runUnconfirmed = data.success !== true;
        currentHistory = undefined;
        currentContents = undefined;
        historyList = undefined;
        renderRun();
      } else if (Object.hasOwn(data, "success")) {
        currentRun = undefined;
        currentContents = data;
        currentHistory = { id: string(data.history_id) };
        firstOffset = Number.isSafeInteger(data.pagination?.offset) ? data.pagination.offset : 0;
        renderContents(data);
      } else {
        currentRun = undefined;
        historyList = data;
        historyVisibleCount = 20;
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
      if (rpc.id !== undefined && pending.has(rpc.id)) {
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
    });

    addEventListener("pagehide", () => {
      viewRequestId += 1;
      detailRequestId += 1;
      for (const handler of pending.values()) {
        clearTimeout(handler.timer);
        handler.reject(new Error("Galaxy view closed"));
      }
      pending.clear();
    });

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
    request("ui/initialize", {
      appInfo: { name: "Galaxy results", version: "1.4.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    }, 15000).then(() => {
      initialized = true;
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      sendSize();
    }).catch(() => {
      if (currentRun && !currentHistory) {
        runUnconfirmed = true;
        renderRun();
        return;
      }
      badge.dataset.state = "error";
      badge.textContent = "Unavailable";
      message.textContent = "The host did not initialize this Galaxy view. Existing results remain available; reopen the app to reconnect.";
    });
  </script>
</body>
</html>`;

export function registerHistorySummaryResource(server: McpServer): void {
  const metadata = {
    ui: {
      prefersBorder: true,
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: ["https://web-sandbox.oaiusercontent.com"],
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
