import type { McpServer } from "@modelcontextprotocol/server";

export const HISTORY_SUMMARY_URI = "ui://galaxy/history-summary-v19.html";

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
      --hover: light-dark(rgba(0, 0, 0, .04), rgba(255, 255, 255, .06));
      --line: light-dark(rgba(0, 0, 0, .08), rgba(255, 255, 255, .11));
      --accent: light-dark(#18181b, #f4f4f5);
      --strong: light-dark(rgba(0, 0, 0, .16), rgba(255, 255, 255, .2));
      --success: light-dark(#248a3d, #30d158);
      --busy: light-dark(#9a6700, #ffd60a);
      --danger: light-dark(#d70015, #ff453a);
      --purple: light-dark(#8944ab, #bf5af2);
      --orange: light-dark(#c93400, #ff9f0a);
      --shadow: 0 1px 2px light-dark(rgba(0, 0, 0, .04), rgba(0, 0, 0, .3));
      --scroll-track: light-dark(rgba(0, 0, 0, .05), rgba(255, 255, 255, .06));
      --scroll-thumb: light-dark(rgba(0, 0, 0, .24), rgba(255, 255, 255, .3));
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 6px; color: var(--text); background: transparent; }
    .card {
      position: relative;
      overflow: hidden;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .header-actions { display: flex; flex: none; align-items: center; gap: 8px; }
    .card[data-collapsed="true"] > :not(header) { display: none !important; }
    .workspace-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0; }
    .workspace-nav select { min-width: 0; max-width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 10px; color: var(--text); background: var(--surface); font: inherit; font-size: .8rem; }
    .workspace-nav select:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .brand-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand-mark { display: grid; place-items: center; flex: none; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
    .brand-mark img { display: block; width: 26px; height: auto; }
    h1 { margin: 0; font-size: 1.02rem; font-weight: 600; letter-spacing: -.025em; line-height: 1.25; }
    h2 { overflow: hidden; margin: 0; font-size: .92rem; font-weight: 550; letter-spacing: -.012em; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    p { margin: 0; }
    .badge { display: inline-flex; flex: none; align-items: center; color: var(--secondary); font-size: .76rem; font-weight: 500; }
    .badge[data-state="error"] { color: var(--danger); }
    .badge[data-state="unknown"] { color: var(--orange); }
    .instance, .message, .meta { color: var(--secondary); }
    .instance { margin-top: 1px; font-size: .76rem; overflow-wrap: anywhere; }
    .message { margin-top: 10px; color: var(--secondary); font-size: .82rem; line-height: 1.4; }
    ul { display: grid; gap: 0; margin: 10px 0 0; padding: 0; border-top: 1px solid var(--line); list-style: none; }
    li { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 7px 4px; border-bottom: 1px solid var(--line); background: transparent; }
    .summary { min-width: 0; }
    .state { margin-top: 4px; color: var(--secondary); font-size: .76rem; }
    .state[data-state="error"], .state[data-state="failed"] { color: var(--danger); }
    .meta { display: grid; flex: none; gap: 1px; overflow-wrap: anywhere; text-align: right; font-size: .72rem; line-height: 1.25; }
    li[data-view="content"] { justify-content: flex-start; }
    .kind { display: grid; flex: none; width: 32px; height: 32px; place-items: center; border-radius: 8px; background: var(--row); color: var(--secondary); font: 600 .6rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .02em; }
    .detail { margin-top: 1px; color: var(--secondary); font-size: .75rem; }
    .hid { margin-right: 6px; color: var(--secondary); font-weight: 400; font-variant-numeric: tabular-nums; }
    .status { color: var(--secondary); font-size: .76rem; font-weight: 500; }
    /* A dataset's state in the colour Galaxy's history panel gives it: done, at work, failed. */
    .status[data-state="ok"] { color: var(--success); }
    .status[data-state="running"] { color: var(--busy); }
    .status[data-state="error"] { color: var(--danger); }
    li[data-view="content"] .meta { margin-left: auto; }
    li[data-clickable="true"] { padding: 0; }
    .content-button { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; padding: 7px 4px; border: 0; border-radius: 8px; color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer; transition: background-color 140ms ease; }
    .content-button .summary { flex: 1; }
    .content-button:hover { background: var(--hover); }
    .content-button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .content-button:disabled { cursor: default; opacity: .66; }
    .view { color: var(--secondary); font-size: .76rem; font-weight: 500; }
    .breadcrumbs { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; color: var(--secondary); font-size: .76rem; }
    .breadcrumbs span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }
    .more-button { margin-top: 10px; }
    .dataset-detail { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
    .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .detail-header > div { min-width: 0; }
    .dataset-detail h2 { white-space: normal; }
    .close-button { min-height: 28px; padding: 3px 10px; border: 1px solid var(--strong); border-radius: 8px; color: var(--text); background: var(--surface); font: inherit; font-size: .78rem; font-weight: 500; cursor: pointer; }
    .close-button:hover:not(:disabled) { background: var(--hover); }
    .close-button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .close-button:disabled { color: var(--secondary); background: var(--row); cursor: default; }
    #detail-close { display: block; margin-top: 14px; }
    #detail-close[hidden] { display: none; }
    #history-link, #report-link, #management-link { display: inline-flex; align-items: center; margin-top: 14px; text-decoration: none; }
    #history-link:hover, #report-link:hover, #management-link:hover { text-decoration: underline; }
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
    .section-title { margin-top: 16px; font-size: .78rem; font-weight: 600; }
    .statistics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin: 8px 0 0; }
    .stat { min-width: 0; padding: 9px 10px; border-radius: 11px; background: color-mix(in srgb, var(--surface) 72%, transparent); }
    .stat dt { color: var(--secondary); font-size: .67rem; }
    .stat dd { overflow-wrap: anywhere; margin: 3px 0 0; font-size: .79rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .modules { display: grid; gap: 5px; margin-top: 8px; }
    .module { display: flex; justify-content: space-between; gap: 12px; padding: 7px 9px; border-radius: 10px; background: color-mix(in srgb, var(--surface) 72%, transparent); font-size: .75rem; }
    .module > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    .module-status { flex: none; font-weight: 700; text-transform: uppercase; }
    .module-status[data-state="pass"] { color: var(--success); }
    .module-status[data-state="warn"] { color: var(--orange); }
    .module-status[data-state="fail"] { color: var(--danger); }
    .caveat { margin-top: 12px; color: var(--secondary); font-size: .72rem; line-height: 1.4; }
    details { margin-top: 14px; }
    summary { color: var(--text); font-size: .78rem; font-weight: 500; cursor: pointer; }
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
    .report-scroll:has(> .dataset-image) { max-height: var(--figure-height, 620px); }
    .dataset-image { display: block; width: auto; max-width: 100%; max-height: calc(var(--figure-height, 620px) - 2px); height: auto; margin: auto; background: white; }
    .dataset-image[data-actual="true"] { max-width: none; max-height: none; }
    .dataset-media { display: block; width: 100%; max-height: 540px; }
    @supports not selector(::-webkit-scrollbar) {
      pre, .report-scroll { scrollbar-color: var(--scroll-thumb) var(--scroll-track); scrollbar-width: thin; }
    }
    pre::-webkit-scrollbar, .report-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
    pre::-webkit-scrollbar-track, .report-scroll::-webkit-scrollbar-track { background: var(--scroll-track); }
    pre::-webkit-scrollbar-thumb, .report-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: var(--scroll-thumb); background-clip: padding-box; }
    pre:focus-visible, .report-scroll:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .workspace { border-radius: 16px; box-shadow: none; background: light-dark(#fff, #212121); }
    .workspace header { flex-wrap: wrap; }
    .workspace .brand-mark { width: 36px; height: 36px; border: 0; border-radius: 7px; }
    .workspace .badge { padding: 0; background: transparent; box-shadow: none; font-weight: 500; }
    .workspace .badge::before { box-shadow: none; }
    .workspace .workspace-nav { padding-bottom: 16px; border-bottom: 1px solid var(--line); font-size: .8rem; }
    .workspace .workspace-nav select { font-size: .85rem; }
    .workspace-history-title { margin: 18px 0 0; font-size: 1.55rem; line-height: 1.3; letter-spacing: -.025em; white-space: normal; overflow-wrap: anywhere; }
    .workspace .close-button { border-radius: 8px; }
    .workspace .close-button:hover { background: var(--hover); }
    .workspace .content-button { padding: 14px 8px; gap: 10px; border-radius: 7px; }
    .workspace .content-button[aria-expanded="true"] { background: var(--hover); }
    .workspace .content-button h2 { font-weight: 550; }
    .workspace .kind { width: 32px; height: 32px; border-radius: 8px; box-shadow: none; font-weight: 600; }
    .workspace .status { padding: 0; background: transparent; box-shadow: none; font-weight: 500; }
    .workspace .dataset-detail { min-width: 0; margin-top: 20px; border: 0; padding-top: 0; }
    .workspace .dataset-detail h2 { font-size: 1.25rem; font-weight: 600; line-height: 1.35; }
    .workspace .file-list-panel { min-width: 0; }
    @media (min-width: 760px) {
      .workspace[data-detail-open="true"][data-files-visible="true"] .browse-body { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(0, 2fr); gap: 20px; }
      .workspace[data-detail-open="true"][data-files-visible="true"] .file-list-panel { padding-right: 16px; border-right: 1px solid var(--line); }
      .workspace[data-detail-open="true"] #histories { margin-top: 20px; }
      .workspace[data-detail-open="true"] .file-list-panel .meta { max-width: 35%; }
      .workspace[data-detail-open="true"] .file-list-panel .view { display: none; }
    }
    @media (max-width: 759px) { .workspace[data-detail-open="true"][data-files-visible="true"] #dataset-detail { display: none; } }
    @media (pointer: coarse) { .workspace .close-button, .workspace .workspace-nav select { min-height: 44px; } .workspace .workspace-nav select { font-size: 1rem; } }
    @media (max-width: 520px) { body { padding: 4px; } .card { padding: 12px; border-radius: 14px; } header { flex-wrap: wrap; gap: 8px; } li, .content-button { align-items: flex-start; } .meta { max-width: 42%; } .statistics { grid-template-columns: 1fr; } }
    /* One row for what can be done with the open history; the upload panel's own controls sit in it. */
    .history-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
    .history-actions:not(:has(> :not([hidden]))) { display: none; }
    .history-actions #history-link { margin-top: 0; }
    .history-actions .caveat { flex-basis: 100%; margin: 0; }
    .upload-panel { display: contents; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main id="galaxy-card" class="card" aria-labelledby="title" data-ui-build="workspace-layout-20261002">
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
      <div class="header-actions">
        <button id="manage-connections" class="close-button" type="button" hidden>Manage connections</button>
        <span id="badge" class="badge">Waiting</span>
        <button id="collapse-card" class="close-button" type="button" aria-controls="galaxy-card" aria-expanded="true">Collapse</button>
      </div>
    </header>
    <button id="detail-close" class="close-button" type="button" hidden>‹ All datasets</button>
    <a id="management-link" class="close-button" target="_blank" rel="noopener noreferrer" hidden>Open connection manager ↗</a>
    <p id="management-note" class="caveat" role="status" aria-live="polite" hidden></p>
    <nav id="workspace-nav" class="workspace-nav" aria-label="Galaxy workspace" hidden>
      <label for="workspace-site">Galaxy site</label>
      <select id="workspace-site" aria-label="Authorized Galaxy site"></select>
      <button id="workspace-histories" class="close-button" type="button">Histories</button>
      <button id="workspace-file-list" class="close-button" type="button" aria-controls="file-list-panel" aria-expanded="false" hidden>Show file list</button>
    </nav>
    <h2 id="workspace-history-title" class="workspace-history-title" hidden></h2>
    <div class="history-actions">
      <a id="history-link" class="close-button" target="_blank" rel="noopener noreferrer" title="Open this history in Galaxy (new tab)" hidden>Open history in Galaxy ↗</a>
      <div id="upload-panel" class="upload-panel" hidden>
        <button id="upload-button" class="close-button" type="button" title="Files go from this device straight to Galaxy">Upload files…</button>
        <button id="upload-cancel" class="close-button" type="button" hidden>Cancel upload</button>
        <input id="upload-input" type="file" multiple hidden>
        <p id="upload-note" class="caveat" role="status" aria-live="polite" hidden></p>
      </div>
      <p id="history-link-note" class="caveat" role="status" hidden></p>
    </div>
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
    <div class="browse-body">
      <section id="file-list-panel" class="file-list-panel" aria-label="Galaxy history browser">
        <ul id="histories" aria-label="Galaxy histories" hidden></ul>
        <div class="list-actions">
          <button id="show-less" class="close-button more-button" type="button" aria-controls="histories" hidden>Load less</button>
          <button id="show-more" class="close-button more-button" type="button" aria-controls="histories" hidden>Load more</button>
        </div>
      </section>
    <section id="dataset-detail" class="dataset-detail" aria-labelledby="detail-title" hidden>
      <div class="detail-header">
        <div>
          <h2 id="detail-title">Dataset contents</h2>
          <p id="detail-message" class="detail" role="status" aria-live="polite"></p>
        </div>
      </div>
      <a id="report-link" class="close-button" target="_blank" rel="noopener noreferrer" title="Open the original report in Galaxy (new tab)" hidden>Open original in Galaxy ↗</a>
      <p id="report-link-note" class="caveat" role="status" hidden></p>
      <div id="detail-body"></div>
    </section>
    </div>
  </main>
  <script>
    const managementOrigin = __MANAGEMENT_ORIGIN__;
    const badge = document.getElementById("badge");
    const title = document.getElementById("title");
    const instance = document.getElementById("instance");
    const manageConnections = document.getElementById("manage-connections");
    const managementLink = document.getElementById("management-link");
    const managementNote = document.getElementById("management-note");
    const workspaceNav = document.getElementById("workspace-nav");
    const workspaceSite = document.getElementById("workspace-site");
    const workspaceHistories = document.getElementById("workspace-histories");
    const card = document.getElementById("galaxy-card");
    const collapseCard = document.getElementById("collapse-card");
    const fileListPanel = document.getElementById("file-list-panel");
    const workspaceFileList = document.getElementById("workspace-file-list");
    const workspaceHistoryTitle = document.getElementById("workspace-history-title");
    let filesVisible = false;
    let workspaceConnections;
    let workspaceInitial;
    let managementAvailable = true;
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
    const uploadPanel = document.getElementById("upload-panel");
    const uploadButton = document.getElementById("upload-button");
    const uploadCancel = document.getElementById("upload-cancel");
    const uploadInput = document.getElementById("upload-input");
    const uploadNote = document.getElementById("upload-note");
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
    // Galaxy reports UTC times without a zone; show the date in the reader's own format.
    const shortDate = value => {
      const date = new Date(/[zZ]|[+-]\\d\\d:?\\d\\d$/.test(value) ? value : value + "Z");
      return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    };
    // A state is shown in Galaxy's own word for it, the one the assistant reads too; anything else is left out.
    const knownStates = new Set(["ok", "empty", "new", "queued", "running", "setting_metadata", "upload", "deferred", "paused", "discarded", "error", "failed_metadata", "failed", "waiting", "deleted"]);
    const stateLabel = value => knownStates.has(string(value).toLowerCase()) ? string(value).toLowerCase() : "";
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
    let uploadAbort;
    // The last file the person uploaded here, so a later "use the file I just uploaded" can be resolved.
    let lastUpload;
    let lastUploads; // every file of the last upload, when it was of several
    let uploadNoteHistory;
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
      uploadPanel.hidden = true;
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
      const expectedSource = method === "tools/call" && params?.name !== "get_connection_management_link" ? sourceGalaxy : undefined;
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

    function uploadStatus(text) {
      uploadNote.textContent = text;
      uploadNote.hidden = false;
      sendSize();
    }

    // The bytes go from this page straight to the Galaxy site (tus). The server only opens the
    // upload with the user's key and, once Galaxy has every byte, turns it into a dataset.
    async function sendFile(file, upload, signal, progress) {
      const headers = { "Tus-Resumable": "1.0.0" };
      const options = { signal, credentials: "omit", referrerPolicy: "no-referrer" };
      let offset = 0;
      let failures = 0;
      while (offset < file.size) {
        try {
          const response = await fetch(upload.url, { ...options, method: "PATCH", body: file.slice(offset, offset + upload.chunk),
            headers: { ...headers, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" } });
          if (response.status !== 204) throw Object.assign(new Error("Galaxy refused the upload (HTTP " + response.status + ")."), { refused: response.status !== 409 && response.status < 500 });
          const next = Number(response.headers.get("Upload-Offset"));
          offset = Number.isSafeInteger(next) && next > offset ? next : Math.min(file.size, offset + upload.chunk);
          failures = 0;
          progress(offset);
        } catch (error) {
          // Before any byte arrived, a network error means the host does not let this page reach Galaxy.
          if (signal.aborted || error?.refused || (offset === 0 && failures === 0 && error instanceof TypeError) || ++failures > 3) throw error;
          const status = await fetch(upload.url, { ...options, method: "HEAD", headers });
          const received = Number(status.headers.get("Upload-Offset"));
          if (!status.ok || !Number.isSafeInteger(received)) throw error;
          offset = received;
        }
      }
    }

    // One file, start to finish. Answers { upload } once Galaxy has it, or why it does not:
    // "text" for a file sent alone, "why" as a clause for a list of several.
    async function uploadOne(file, history, source, abort, say) {
      const name = string(file.name) || "upload";
      if (!file.size) return { name, why: "the file is empty", text: "This file is empty, so nothing was uploaded." };
      const target = { historyId: string(history.id), fileName: name };
      uploadCancel.hidden = false;
      say("Starting the upload of " + name + "…");
      let stage = "start";
      try {
        const started = await request("tools/call", { name: "start_file_upload", arguments: { ...target, size: file.size } });
        const upload = started?.structuredContent?.upload;
        if (started?.isError || !upload) throw new Error(string(started?.structuredContent?.message) || "Galaxy did not start the upload.");
        const url = new URL(upload.url);
        if (url.protocol !== "https:" || url.origin !== new URL(source.url).origin) throw new Error("Galaxy returned an upload address on another site.");
        if (abort.signal.aborted) throw new Error("Cancelled");
        stage = "send";
        await sendFile(file, { url: url.href, chunk: Number.isSafeInteger(upload.chunk_bytes) && upload.chunk_bytes > 0 ? upload.chunk_bytes : 10485760 }, abort.signal,
          sent => say("Uploading " + name + " to Galaxy: " + Math.floor(sent / file.size * 100) + "%"));
        stage = "finish";
        uploadCancel.hidden = true;
        say("Adding " + name + " to the history…");
        const finished = await request("tools/call", { name: "finish_file_upload", arguments: { ...target, sessionId: string(upload.session_id) } });
        if (finished?.isError || finished?.structuredContent?.success !== true) throw new Error(string(finished?.structuredContent?.message) || "Galaxy did not add the file.");
        return { name, upload: { file_name: name, dataset_id: string(finished.structuredContent.data?.outputs?.[0]?.id) || null, history_id: string(history.id),
          uploaded_at: new Date().toISOString(), note: "Uploaded by the user with this card; Galaxy may still be processing it." } };
      } catch (error) {
        if (abort.signal.aborted) return { name, cancelled: true };
        if (stage === "send" && error instanceof TypeError) return { name, blocked: true };
        // One sentence, whether or not the reason came with its own full stop.
        const reason = fallback => string(error?.message).replace(/[.\\s]+$/, "") || fallback;
        return stage === "finish"
          ? { name, why: reason("Galaxy did not confirm the file") + "; check the history in Galaxy before uploading it again",
            text: reason("Galaxy did not confirm the file") + ". Check the history in Galaxy before uploading again." }
          : { name, why: reason("The upload failed"), text: reason("The upload failed") + ". Nothing was added to the history." };
      }
    }

    // The chosen files, one after another, so each has the whole connection and its own outcome.
    async function uploadFiles(files) {
      const history = currentHistory;
      const source = sourceGalaxy;
      if (uploadAbort || !files.length || !toolsAvailable() || !source || !string(history?.id)) return;
      uploadNoteHistory = string(history.id);
      const abort = uploadAbort = new AbortController();
      const several = files.length > 1;
      const done = [];
      const missed = [];
      let ended = "";
      uploadButton.disabled = true;
      try {
        for (const [index, file] of files.entries()) {
          const result = await uploadOne(file, history, source, abort, text => uploadStatus((several ? "File " + (index + 1) + " of " + files.length + ": " : "") + text));
          if (result.upload) done.push(result.upload);
          else if (result.cancelled) ended = "Upload cancelled.";
          // A host that keeps this page from Galaxy keeps it from every file.
          else if (result.blocked) ended = "This app did not let the card reach Galaxy. Open the history in Galaxy and upload the " + (several ? "files" : "file") + " there.";
          else missed.push(result);
          if (ended) break;
        }
        const them = done.length === 1 ? "it" : "them";
        const landed = !done.length ? ""
          : (!several ? done[0].file_name + " is" : done.length === files.length ? "All " + files.length + " files are" : done.length + " of " + files.length + " files " + (done.length === 1 ? "is" : "are"))
            + " in Galaxy, which is now processing " + them + ". Tell the assistant when you want to use " + them + ".";
        const nothing = abort.signal.aborted || (several && !ended) ? "Nothing was added to the history." : "";
        const lost = !several ? missed[0]?.text || "" : missed.length ? "Not uploaded: " + missed.map(each => each.name + " (" + each.why + ")").join("; ") + "." : "";
        uploadStatus([ended, landed || nothing, lost].filter(Boolean).join(" "));
        if (done.length) {
          lastUpload = done[done.length - 1];
          lastUploads = done;
          if (currentHistory === history && datasetDetail.hidden && !closed) void openHistory(history);
          else if (viewContext) publishView(viewContext);
        }
      } finally {
        uploadAbort = undefined;
        uploadButton.disabled = false;
        uploadCancel.hidden = true;
      }
    }
    uploadButton.addEventListener("click", () => { if (!uploadAbort) uploadInput.click(); });
    uploadCancel.addEventListener("click", () => uploadAbort?.abort());
    uploadInput.addEventListener("change", () => {
      const files = Array.from(uploadInput.files || []);
      uploadInput.value = "";
      if (files.length) void uploadFiles(files);
    });

    let sizePending = false;
    let lastHeight;
    let figureHeightLimit;
    function sendSize() {
      if (!initialized || closed || sizePending) return;
      sizePending = true;
      requestAnimationFrame(() => {
        sizePending = false;
        if (!initialized || closed) return;
        const image = detailBody.querySelector("img");
        if (image?.className === "dataset-image") {
          const scroller = image.parentElement;
          const controlsHeight = document.documentElement.getBoundingClientRect().height - scroller.getBoundingClientRect().height;
          scroller.style.setProperty("--figure-height", (figureHeightLimit === undefined ? 620 : Math.max(3, figureHeightLimit - controlsHeight)) + "px");
        }
        const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
        if (height === lastHeight) return;
        lastHeight = height;
        post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } });
      });
    }

    manageConnections.hidden = true;
    manageConnections.addEventListener("click", async () => {
      if (!toolsAvailable() || manageConnections.disabled) return;
      manageConnections.disabled = true;
      manageConnections.textContent = "Opening…";
      managementLink.hidden = true;
      managementLink.removeAttribute("href");
      managementNote.hidden = true;
      try {
        const result = await request("tools/call", { name: "get_connection_management_link", arguments: {} });
        if (result?.isError) throw new Error("Management link unavailable");
        const url = new URL(string(result?.structuredContent?.url));
        if (url.protocol !== "https:" || url.origin !== managementOrigin
          || !/^\\/connections\\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
          || url.search || url.hash || url.username || url.password) throw new Error("Invalid management link");
        managementLink.setAttribute("href", url.href);
        if (!canOpenLinks) {
          managementLink.hidden = false;
          managementNote.textContent = "Your private link is ready.";
          managementNote.hidden = false;
        } else {
          const opened = await request("ui/open-link", { url: url.href });
          if (opened?.isError) throw new Error("Link was not opened");
        }
      } catch {
        if (managementLink.getAttribute("href")) {
          managementLink.hidden = false;
          managementNote.textContent = "The host could not open this link. Open or copy it below.";
        } else {
          managementNote.textContent = "Connection management is unavailable here. Ask in chat to manage Galaxy connections.";
        }
        managementNote.hidden = false;
      } finally {
        manageConnections.disabled = !toolsAvailable();
        manageConnections.textContent = "Manage connections";
        sendSize();
      }
    });

    function publishView(value) {
      viewContext = { ...value, ...(sourceGalaxy && { galaxy: sourceGalaxy }), ...(lastUpload && { last_upload: lastUpload }), ...(lastUploads?.length > 1 && { last_uploads: lastUploads }), view_id: sourceViewId || null, display_verified: false,
        surface: workspaceConnections ? "workspace" : "card",
        scope: workspaceConnections ? "This open Galaxy panel only. Prefer its controls; do not create a card for each lookup. Content loading does not verify visible display."
          : "This card only, not other tool calls or the user's workspace. Content loading does not verify visible display." };
      if (!initialized || !canUpdateContext || closed) return;
      const serialized = JSON.stringify(viewContext);
      if (serialized === lastSentContext) return;
      lastSentContext = serialized;
      // Host context updates inform future turns; they do not verify what a person has seen.
      void request("ui/update-model-context", { structuredContent: viewContext }, 5000).catch(() => {});
    }

    function renderWorkspace(data) {
      uploadPanel.hidden = true;
      sourceGalaxy = undefined;
      viewRequestId += 1;
      detailRequestId += 1;
      currentRun = undefined;
      currentHistory = undefined;
      currentContents = undefined;
      historyList = undefined;
      visibleCount = CONTENT_PAGE_SIZE;
      historyVisibleCount = CONTENT_PAGE_SIZE;
      workspaceConnections = Array.isArray(data.connections) ? data.connections.filter(value => {
        try { const url = new URL(value.url); return string(value.instance) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
        catch { return false; }
      }) : [];
      renderHistories({ status: "connected", histories: [] });
      managementAvailable = data.management_available === true;
      manageConnections.hidden = !managementAvailable || !canCallTools;
      workspaceNav.hidden = false;
      workspaceSite.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = workspaceConnections.length ? "Choose a Galaxy site" : "No authorized sites";
      workspaceSite.append(placeholder);
      for (const connection of workspaceConnections) {
        const option = document.createElement("option");
        option.value = connection.instance;
        option.textContent = connection.instance + " · " + new URL(connection.url).host;
        workspaceSite.append(option);
      }
      workspaceInitial = data.initial;
      const selected = workspaceConnections.find(value => value.instance === data.initial?.galaxy?.instance && value.url === data.initial?.galaxy?.url);
      workspaceSite.value = selected?.instance || "";
      workspaceHistories.disabled = !selected || !toolsAvailable();
      title.textContent = "Galaxy workspace";
      message.textContent = workspaceConnections.length ? "Choose a site to browse its histories and reports. Analyses stay on their original Galaxy site." : "Connect a Galaxy account in your client to begin.";
      badge.textContent = workspaceConnections.length ? "Connected" : "Not configured";
      badge.dataset.state = workspaceConnections.length ? "connected" : "neutral";
      // The label says what state the card is in only when that is not the ordinary one.
      badge.hidden = workspaceConnections.length > 0;
      publishView({ view: "workspace", authorized_sites: workspaceConnections, selected_site: selected || null });
      if (workspaceInitial) { const initial = workspaceInitial; workspaceInitial = undefined; render({ ...initial, ...(sourceViewId && { presentation: { view_id: sourceViewId } }) }, true); }
      sendSize();
    }

    async function loadWorkspaceHistories() {
      const selected = workspaceConnections?.find(value => value.instance === workspaceSite.value);
      const requestId = ++viewRequestId;
      detailRequestId += 1;
      clearTimeout(runTimer);
      sourceGalaxy = selected;
      localNavigation = true;
      currentRun = undefined;
      currentHistory = undefined;
      currentContents = undefined;
      historyList = undefined;
      visibleCount = CONTENT_PAGE_SIZE;
      historyVisibleCount = CONTENT_PAGE_SIZE;
      histories.removeAttribute("aria-busy");
      workspaceHistories.disabled = !selected || !toolsAvailable();
      renderHistories({ status: selected ? "connected" : "not_configured", histories: [], message: selected ? "Loading histories…" : "Choose a Galaxy site." });
      publishView({ view: "workspace", selected_site: selected || null });
      if (!selected || !toolsAvailable()) return;
      try {
        const result = await request("tools/call", { name: "get_histories", arguments: { limit: CONTENT_PAGE_SIZE, offset: 0 } });
        if (requestId !== viewRequestId) return;
        if (result?.isError || result?.structuredContent?.status !== "connected") throw new Error("Histories unavailable");
        historyList = result.structuredContent;
        renderHistories(historyList);
      } catch {
        if (requestId !== viewRequestId) return;
        renderHistories({ status: "error", histories: [], message: "Histories could not be loaded. Select Histories to retry; no analysis was submitted." });
      } finally { if (requestId === viewRequestId) sendSize(); }
    }
    workspaceSite.addEventListener("change", loadWorkspaceHistories);
    workspaceHistories.addEventListener("click", loadWorkspaceHistories);

    function updateListVisibility() {
      const detailOpen = !datasetDetail.hidden;
      const listVisible = !detailOpen || (workspaceConnections && filesVisible);
      card.className = workspaceConnections ? "card workspace" : "card";
      card.dataset.detailOpen = String(detailOpen);
      card.dataset.filesVisible = String(filesVisible);
      fileListPanel.hidden = !listVisible || histories.childElementCount === 0;
      histories.hidden = fileListPanel.hidden;
      message.hidden = detailOpen;
      detailClose.hidden = !detailOpen;
      showMore.hidden = !listVisible || !canShowMore;
      showLess.hidden = !listVisible || histories.childElementCount <= CONTENT_PAGE_SIZE;
      workspaceFileList.hidden = !workspaceConnections || !detailOpen || !currentContents;
      workspaceFileList.textContent = filesVisible ? "Hide file list" : "Show file list";
      workspaceFileList.setAttribute("aria-expanded", String(filesVisible));
    }
    workspaceFileList.addEventListener("click", () => {
      if (workspaceFileList.hidden) return;
      filesVisible = !filesVisible;
      updateListVisibility();
      workspaceFileList.focus();
      sendSize();
    });

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
      workspaceHistoryTitle.hidden = true;
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
      badge.hidden = false;
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
      publishView({ view: "run_status", kind: currentRun.kind, run_id: currentRun.id, name: currentRun.name, history_id: currentRun.history_id || null, report_status: "not_open", state, checked_at: currentRun.checked_at });
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
      workspaceHistoryTitle.hidden = true;
      workspaceHistoryTitle.textContent = "";
      setHistoryLink();
      closeDatasetDetail(false);
      runPanel.hidden = true;
      syncRunRefresh();
      const status = Object.hasOwn(labels, data.status) ? data.status : "error";
      const items = Array.isArray(data.histories) ? data.histories.filter(value => value && typeof value === "object") : [];
      const rows = items.slice(0, visibleCount);

      breadcrumbs.hidden = true;
      historyBack.textContent = "‹ Histories";
      title.textContent = workspaceConnections ? "Galaxy workspace" : "Galaxy histories";
      histories.setAttribute("aria-label", "Galaxy histories");
      badge.dataset.state = status;
      badge.textContent = labels[status];
      badge.hidden = status === "connected";
      instance.textContent = sourceLabel() || string(data.instance);
      instance.hidden = !!workspaceConnections || !instance.textContent;
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
        summary.append(name);
        if (state.textContent) summary.append(state);
        meta.className = "meta";
        if (string(value.update_time)) {
          const updated = document.createElement("span");
          updated.textContent = "Updated " + shortDate(string(value.update_time));
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

    // The tile and the line under a name, as the upstream galaxy-mcp card writes them.
    function contentKind(value) {
      const extension = string(value.extension || value.file_ext).toLowerCase();
      if (string(value.history_content_type || value.type).toLowerCase().includes("collection")) {
        const elements = typeof value.element_count === "number" ? ", " + value.element_count + " elements" : "";
        return { format: "SET", detail: (string(value.collection_type) || "collection") + elements };
      }
      const format = /^fast[aq]/.test(extension) ? extension.slice(0, 5).toUpperCase()
        : extension === "tabular" ? "TABLE" : extension.slice(0, 6).toUpperCase() || "DATA";
      return { format, detail: [extension, value.deleted === true ? "deleted" : "", value.visible === false ? "hidden" : ""].filter(Boolean).join(" \u00b7 ") };
    }

    function renderContents(data, keepDetail = false) {
      setHistoryLink(data);
      const selectedId = keepDetail ? activeContentButton?.dataset.datasetId : undefined;
      if (!keepDetail) closeDatasetDetail(false);
      runPanel.hidden = true;
      syncRunRefresh();
      const success = data.success === true && Array.isArray(data.data);
      const items = success ? data.data.filter(value => value && typeof value === "object") : [];
      const rows = items.slice(0, visibleCount);
      const status = success ? "connected" : data.errorKind === "connection" ? "not_configured" : "error";
      // A whole history bound to its site can receive a file; a search result or a single report cannot.
      uploadPanel.hidden = !(success && !data.search && data.view !== "dataset" && string(currentHistory?.id) && sourceGalaxy && canCallTools && typeof fetch === "function");
      if (string(currentHistory?.id) !== uploadNoteHistory) uploadNote.hidden = true;

      breadcrumbs.hidden = !!workspaceConnections || (!historyList && !currentRun);
      historyBack.textContent = currentRun ? "‹ Run status" : "‹ Histories";
      historyName.textContent = string(currentHistory?.name) || "History contents";
      // Opened from the history list, the breadcrumbs already carry the name.
      title.textContent = workspaceConnections ? "Galaxy workspace" : data.view === "dataset" ? "Galaxy report" : currentRun ? "History results"
        : breadcrumbs.hidden && string(currentHistory?.name) || "History contents";
      workspaceHistoryTitle.textContent = string(currentHistory?.name) || "History contents";
      workspaceHistoryTitle.hidden = !workspaceConnections;
      histories.setAttribute("aria-label", "Galaxy history contents");
      badge.dataset.state = status;
      badge.textContent = success ? data.view === "dataset" ? "Report" : "Results" : labels[status];
      badge.hidden = success;
      instance.textContent = sourceLabel() || "Galaxy results";
      instance.hidden = !!workspaceConnections;
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
        const canOpen = stateValue === "ok" && string(value.id) && value.deleted !== true && value.purged !== true
          && !string(value.history_content_type || value.type).toLowerCase().includes("collection");

        row.dataset.view = "content";
        kind.className = "kind";
        kind.textContent = descriptor.format;
        kind.setAttribute("aria-hidden", "true");
        summary.className = "summary";
        const label = string(value.name) || "Untitled dataset";
        name.textContent = label;
        // The item's number in its history, before its name, as Galaxy lists it.
        if (typeof value.hid === "number") {
          const hid = document.createElement("span");
          hid.className = "hid";
          hid.textContent = value.hid + ":";
          name.prepend(hid);
        }
        detail.className = "detail";
        detail.textContent = descriptor.detail;
        meta.className = "meta";
        state.className = "status";
        state.dataset.state = stateValue === "ok" ? "ok" : ["error", "failed", "discarded"].includes(stateValue) ? "error"
          : ["running", "setting_metadata", "upload"].includes(stateValue) ? "running" : "neutral";
        state.textContent = stateLabel(stateValue);
        summary.append(name);
        if (detail.textContent) summary.append(detail);
        if (state.textContent) meta.append(state);
        if (canOpen) {
          const view = document.createElement("span");
          const button = document.createElement("button");
          view.className = "view";
          view.textContent = "View ›";
          meta.append(view);
          button.className = "content-button";
          button.type = "button";
          button.disabled = !toolsAvailable();
          button.setAttribute("aria-label", "View contents of " + label);
          button.dataset.datasetId = string(value.id);
          button.setAttribute("aria-expanded", String(value.id === selectedId));
          if (value.id === selectedId) activeContentButton = button;
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
      if (!keepDetail) publishView({ view: "history_contents", history_id: currentHistory?.id, report_status: "not_open", visible_items: rows.map(item => ({ id: item.id, name: item.name })), loaded_count: items.length, has_more: data.pagination?.has_more === true });
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
        const result = await request("tools/call", { name: "get_history_contents", arguments: { historyId: string(value.id), order: "newest", limit: CONTENT_PAGE_SIZE, offset: 0 } });
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
        renderContents(currentContents, !!workspaceConnections && !datasetDetail.hidden);
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
        const result = await request("tools/call", { name: "get_history_contents", arguments: { ...currentContents.filters, order: currentContents.order ?? "newest", historyId: string(currentHistory.id), limit: CONTENT_PAGE_SIZE, offset } });
        if (requestId !== viewRequestId || detailId !== detailRequestId) return;
        const page = result?.structuredContent;
        if (result?.isError || page?.success !== true || !Array.isArray(page.data)) throw new Error("Page unavailable");
        // An item added since the last page moves a newest-first listing down by one; show each once.
        // A dataset and a collection can carry the same id, so the kind is part of the key.
        const key = item => item.history_content_type + ":" + item.id;
        const loaded = new Set(previous.data.map(key));
        currentContents = { ...page, data: [...previous.data, ...page.data.filter(item => !loaded.has(key(item)))] };
        visibleCount = Math.min(visibleCount + CONTENT_PAGE_SIZE, currentContents.data.length);
        renderContents(currentContents, !!workspaceConnections && !datasetDetail.hidden);
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
      if (currentContents) renderContents(currentContents, !!workspaceConnections && !datasetDetail.hidden);
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
      filesVisible = false;
      datasetDetail.removeAttribute("aria-busy");
      detailBody.replaceChildren();
      updateListVisibility();
      if (activeContentButton) {
        activeContentButton.disabled = false;
        activeContentButton.setAttribute("aria-expanded", "false");
        if (returnFocus) (activeContentButton.isConnected === false ? histories.children[0]?.children[0] : activeContentButton)?.focus();
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
        + (text.length || data.preview_kind === "text" ? " · " + String(text.length) + " characters" : " · preview")
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

      if (!text) return;
      const raw = document.createElement("details");
      const rawLabel = document.createElement("summary");
      const rawText = document.createElement("pre");
      rawLabel.textContent = "Raw text · scroll sideways";
      rawText.textContent = text;
      if (string(data.extension).toLowerCase() === "json" && data.truncated !== true) {
        try { rawText.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Keep the actual source if it is not complete JSON. */ }
      }
      rawText.tabIndex = 0;
      rawText.setAttribute("role", "region");
      rawText.setAttribute("aria-label", "Raw dataset text; scroll horizontally for long lines");
      raw.open = parsed.modules.length === 0 && !["pdf", "image", "svg", "audio", "video", "table"].includes(data.preview_kind);
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

    function renderDatasetSummary(value, metadata) {
      detailBody.replaceChildren();
      const data = metadata || value;
      const info = document.createElement("dl");
      info.className = "statistics";
      for (const [label, content] of [["Format", data.extension || data.file_ext], ["Status", stateLabel(data.state)], ["Size", Number.isFinite(data.file_size) ? data.file_size.toLocaleString() + " bytes" : undefined], ["Genome", data.metadata_dbkey]]) {
        if (content === undefined || content === null || content === "") continue;
        const stat = document.createElement("div");
        const term = document.createElement("dt");
        const description = document.createElement("dd");
        stat.className = "stat";
        term.textContent = label;
        description.textContent = String(content);
        stat.append(term, description);
        info.append(stat);
      }
      detailBody.append(info);
      if (typeof data.peek === "string" && data.peek.trim()) {
        const scroller = document.createElement("div");
        scroller.className = "report-scroll";
        scroller.tabIndex = 0;
        scroller.setAttribute("aria-label", "Galaxy-generated dataset summary");
        scroller.append(reportPreview(data.peek.slice(0, 100000)).preview);
        detailBody.append(scroller);
      }
      const note = document.createElement("p");
      note.className = "report-note";
      note.textContent = (typeof data.peek === "string" && data.peek.trim() ? "Galaxy-generated summary" : "Dataset metadata")
        + ", not the full file. Open the original in Galaxy for datatype-specific viewers or download.";
      detailBody.append(note);
    }

    function renderDatasetPreview(result, value, button) {
      const data = result.structuredContent;
      renderDatasetText(data);
      const preview = result._meta?.preview;
      const image = result.content?.find(block => block.type === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType));
      const asset = image || (["svg", "audio", "video"].includes(preview?.kind) ? preview : undefined);
      if (asset && typeof asset.data === "string" && asset.data.length <= 2700000 && /^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)) {
        const kind = preview?.kind;
        const allowed = kind === "audio" ? ["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4"]
          : kind === "video" ? ["video/mp4", "video/webm", "video/ogg"]
          : ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
        if (allowed.includes(asset.mimeType)) {
          const media = document.createElement(kind === "audio" || kind === "video" ? kind : "img");
          media.className = kind === "audio" || kind === "video" ? "dataset-media" : "dataset-image";
          media.setAttribute("src", "data:" + asset.mimeType + ";base64," + asset.data);
          if (kind === "audio" || kind === "video") {
            media.setAttribute("controls", "");
            media.setAttribute("preload", "metadata");
          } else media.setAttribute("alt", string(data.name) || "Dataset preview");
          media.addEventListener("load", sendSize, { once: true });
          media.addEventListener("loadedmetadata", sendSize, { once: true });
          media.addEventListener("error", () => { detailMessage.textContent = "This host could not display the preview. Open the original in Galaxy."; sendSize(); }, { once: true });
          const scroller = document.createElement("div");
          scroller.className = "report-scroll";
          scroller.tabIndex = 0;
          scroller.setAttribute("aria-label", media.tagName === "IMG" ? "Dataset preview; whole page fits the viewing area" : "Dataset preview");
          scroller.append(media);
          detailBody.prepend(scroller);
          if (media.tagName === "IMG") {
            const zoom = document.createElement("button");
            zoom.className = "close-button";
            zoom.type = "button";
            zoom.textContent = "Actual size";
            zoom.setAttribute("aria-pressed", "false");
            zoom.addEventListener("click", () => {
              const actual = media.dataset.actual !== "true";
              media.dataset.actual = String(actual);
              zoom.setAttribute("aria-pressed", String(actual));
              zoom.textContent = actual ? "Fit page" : "Actual size";
              scroller.setAttribute("aria-label", actual ? "Dataset preview; scroll for more detail" : "Dataset preview; whole page fits the viewing area");
              sendSize();
            });
            detailBody.prepend(zoom);
          }
        }
      }
      if (preview?.kind === "table" && Array.isArray(preview.rows) && parseFastqc(string(data.text)).modules.length === 0) {
        const scroller = document.createElement("div");
        const table = document.createElement("table");
        const caption = document.createElement("caption");
        caption.textContent = "Table preview" + (preview.limited ? " · partial excerpt" : "");
        table.append(caption);
        for (const row of preview.rows.slice(0, 50)) {
          if (!Array.isArray(row)) continue;
          const tr = document.createElement("tr");
          for (const cell of row.slice(0, 50)) {
            const td = document.createElement("td");
            td.textContent = string(cell).slice(0, 2000);
            tr.append(td);
          }
          table.append(tr);
        }
        scroller.className = "report-preview report-scroll";
        scroller.tabIndex = 0;
        scroller.setAttribute("aria-label", "Table preview; scroll horizontally for columns");
        scroller.append(table);
        detailBody.prepend(scroller);
      }
      if (Array.isArray(data.limitations) && data.limitations.length) {
        const note = document.createElement("p");
        note.className = "report-note";
        note.textContent = data.limitations.filter(item => typeof item === "string").join(" ");
        detailBody.append(note);
      }
      const page = Number.isSafeInteger(data.page) ? data.page : 1;
      const pages = Number.isSafeInteger(data.page_count) ? data.page_count : 1;
      const offset = Number.isSafeInteger(data.offset) ? data.offset : 0;
      const actions = document.createElement("div");
      actions.className = "run-actions";
      const add = (label, targetPage, targetOffset) => {
        const action = document.createElement("button");
        action.className = "close-button";
        action.type = "button";
        action.textContent = label;
        action.addEventListener("click", () => { action.disabled = true; return openDataset(value, activeContentButton || button, targetPage, targetOffset, data.source_sha256); });
        actions.append(action);
      };
      const unit = data.preview_kind === "image" ? "frame" : "page";
      if (page > 1) add("Previous " + unit, page - 1, 0);
      if (page < pages) add("Next " + unit, page + 1, 0);
      if (offset > 0) add("Previous text", page, Math.max(0, offset - 20000));
      if (Number.isSafeInteger(data.next_offset) && data.next_offset > offset) add("More text", page, data.next_offset);
      if (actions.childElementCount) detailBody.append(actions);
      if (pages > 1) detailMessage.textContent = (data.preview_kind === "image" ? "Frame " : "Page ") + page + " of " + pages;
    }

    async function openDataset(value, button, page = 1, offset = 0, expectedHash) {
      if (!toolsAvailable() || button.disabled) return;
      localNavigation = true;
      const requestId = ++detailRequestId;
      setReportLink();
      try {
        if (sourceGalaxy) setReportLink({ dataset_id: string(value.id), url: new URL("datasets/" + encodeURIComponent(value.id) + "/display", sourceGalaxy.url.replace(/\\/$/, "") + "/").href });
      } catch { /* Only the bound Galaxy source may provide the original-file link. */ }
      if (activeContentButton && activeContentButton !== button) {
        activeContentButton.disabled = false;
        activeContentButton.setAttribute("aria-expanded", "false");
      }
      activeContentButton = button;
      button.disabled = true;
      button.setAttribute("aria-expanded", "true");
      datasetDetail.hidden = false;
      if (!expectedHash) filesVisible = false;
      datasetDetail.setAttribute("aria-busy", "true");
      detailTitle.textContent = string(value.name) || "Dataset contents";
      detailMessage.textContent = "Loading real Galaxy data…";
      const reportContext = { view: "report", dataset_id: string(value.id), name: string(value.name) };
      publishView({ ...reportContext, report_status: "loading", display_verified: false });
      if (!expectedHash) detailBody.replaceChildren();
      updateListVisibility();
      if (!expectedHash) detailClose.focus();
      sendSize();

      let contentRejected = false;
      try {
        const html = string(value.extension || value.file_ext).toLowerCase() === "html";
        const result = await request("tools/call", {
          name: html ? "get_dataset_html" : "read_dataset_report",
          arguments: { datasetId: string(value.id), ...(!html && { page, offset, includeImage: true }) },
        });
        if (requestId !== detailRequestId) return;
        contentRejected = result?.isError === true;
        if (result?.isError || !result?.structuredContent) {
          throw new Error("Dataset content was unavailable");
        }
        if (expectedHash && result.structuredContent.source_sha256 !== expectedHash) throw new Error("Dataset changed between previews");
        if (html && typeof result?._meta?.html === "string") {
          setReportLink(result.structuredContent);
          renderDatasetHtml(result.structuredContent, result._meta.html);
          publishView({ ...reportContext, report_status: "content_loaded", presentation: "static_report_preview", display_verified: false, report_content_in_feedback: false });
        } else if (!html && typeof result.structuredContent.text === "string") {
          setReportLink(result.structuredContent);
          renderDatasetPreview(result, value, button);
          publishView({ ...reportContext, report_status: "text_view_ready", characters_returned: result.structuredContent.text.length, truncated: result.structuredContent.truncated === true });
        } else {
          throw new Error("Dataset text was unavailable");
        }
      } catch {
        if (requestId !== detailRequestId) return;
        detailMessage.textContent = expectedHash ? "The requested page could not be confirmed. The last loaded preview is retained. Go back to All datasets to reload."
          : contentRejected ? "Full-file preview is unavailable; dataset details and the original Galaxy link remain available."
          : "This report could not be loaded as a full preview. Dataset details and original file remain available. Go back to All datasets to try again.";
        publishView({ ...reportContext, report_status: "load_failed", display_verified: false });
        if (!expectedHash) {
          renderDatasetSummary(value);
          if (contentRejected) void request("tools/call", { name: "get_dataset_details", arguments: { datasetId: string(value.id) } }).then(details => {
            if (requestId !== detailRequestId) return;
            if (details?.structuredContent?.success === true && details.structuredContent.data?.id === value.id) {
              renderDatasetSummary(value, details.structuredContent.data);
              detailMessage.textContent = "Galaxy dataset summary · not a full-file preview";
              publishView({ ...reportContext, report_status: "summary_loaded", coverage: "Galaxy-generated summary only", display_verified: false });
              sendSize();
            }
          }).catch(() => {}); // Keep known metadata and the original link if Galaxy's summary is unavailable.
        }
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

    function render(candidate, workspaceInitialView = false) {
      if (closed) return;
      const data = candidate?.structuredContent ?? candidate;
      if (!data || typeof data !== "object") return;
      const incomingViewId = string(data.presentation?.view_id);
      if (localNavigation && (!incomingViewId || incomingViewId === sourceViewId)) return;
      // Host layout/context updates may replay the current result; only a new presentation replaces it.
      if (incomingViewId && !workspaceInitialView && seenViewIds.has(incomingViewId)) return;
      if (incomingViewId) seenViewIds.add(incomingViewId);
      sourceViewId = incomingViewId;
      if (data.view === "workspace") { localNavigation = false; renderWorkspace(data); return; }
      if (!workspaceInitialView) { workspaceConnections = undefined; workspaceNav.hidden = true; workspaceHistoryTitle.hidden = true; }
      sourceGalaxy = undefined;
      try {
        const url = new URL(data.galaxy?.url);
        if (string(data.galaxy?.instance) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
          sourceGalaxy = { instance: data.galaxy.instance, url: data.galaxy.url };
        }
      } catch { /* Missing or invalid source leaves the view unbound. */ }
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
        currentHistory = { id: string(data.history_id), name: string(data.history_name) };
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
      if (rpc.method === "ui/notifications/host-context-changed") applyHostContext(rpc.params);
    });

    function closeView() {
      closed = true;
      uploadAbort?.abort();
      initialized = false;
      manageConnections.disabled = true;
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

    function applyHostContext(context) {
      applyTheme(context?.theme);
      if (!context?.containerDimensions) return;
      const height = context.containerDimensions.height ?? context.containerDimensions.maxHeight;
      // Use the host's limit, not the iframe's self-sized height, to avoid resize feedback loops.
      figureHeightLimit = Number.isFinite(height) && height > 0 ? height : undefined;
      sendSize();
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
          appInfo: { name: "Galaxy results", version: "1.10.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        }, 15000);
        if (closed) return;
        initialized = true;
        viewReconnect.hidden = true;
        if (result?.hostCapabilities !== undefined) canCallTools = !!result.hostCapabilities?.serverTools;
        canUpdateContext = !!result?.hostCapabilities?.updateModelContext;
        canOpenLinks = !!result?.hostCapabilities?.openLinks;
        manageConnections.hidden = !canCallTools || !managementAvailable;
        workspaceSite.disabled = !canCallTools;
        workspaceHistories.disabled = !canCallTools || !workspaceSite.value;
        applyHostContext(result?.hostContext);
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
        if (!datasetDetail.hidden && localNavigation) {
          if (viewContext) publishView(viewContext);
        } else if (currentRun && !currentHistory) renderRun();
        else if (currentContents) renderContents(currentContents);
        else if (historyList) renderHistories(historyList);
        else if (workspaceConnections) {
          title.textContent = "Galaxy workspace";
          message.textContent = workspaceConnections.length ? "Choose a site to browse its histories and reports." : "Connect a Galaxy account in your client to begin.";
        } else {
          badge.dataset.state = "neutral";
          badge.textContent = "Waiting";
          badge.hidden = false;
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
          badge.hidden = false;
          message.textContent = "The host did not initialize this Galaxy view. Existing results remain available; reconnect this view to try again.";
        }
      } finally {
        initializing = false;
        viewReconnect.disabled = closed;
        sendSize();
      }
    }
    viewReconnect.addEventListener("click", initializeView);
    collapseCard.addEventListener("click", () => {
      const collapsed = card.dataset.collapsed !== "true";
      card.dataset.collapsed = String(collapsed);
      collapseCard.textContent = collapsed ? "Expand" : "Collapse";
      collapseCard.setAttribute("aria-expanded", String(!collapsed));
      sendSize();
    });
    void initializeView();
  </script>
</body>
</html>`;

/**
 * `authOrigin` is the OAuth broker's origin, where connection-management links open.
 * `galaxyOrigins` are the user's authorized Galaxy sites, the only hosts the card may
 * contact itself: its Upload button sends a chosen file straight to them.
 */
export function registerHistorySummaryResource(server: McpServer, domain?: string, authOrigin?: string, galaxyOrigins: string[] = []): void {
  const html = HTML.replace("__MANAGEMENT_ORIGIN__", () => JSON.stringify(authOrigin ?? ""));
  const metadata = {
    // Host-specific origins are not portable. Claude uses its default isolated origin.
    ...(domain && { "openai/widgetDomain": domain }),
    "openai/widgetCSP": {
      connect_domains: galaxyOrigins,
      resource_domains: [],
      redirect_domains: authOrigin ? [authOrigin] : [],
    },
    ui: {
      prefersBorder: true,
      csp: {
        connectDomains: galaxyOrigins,
        resourceDomains: [],
      },
    },
  };
  server.registerResource(
    "galaxy-history",
    HISTORY_SUMMARY_URI,
    { title: "Galaxy runs, histories and results", mimeType: MIME_TYPE, _meta: metadata },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: MIME_TYPE, text: html, _meta: metadata }],
    }),
  );
}
