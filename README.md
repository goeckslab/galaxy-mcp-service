# galaxy-mcp-service

A Streamable HTTP MCP server for Galaxy. It lets compatible AI clients inspect histories and reports, find tools and workflows, submit analyses and check their results. Galaxy executes the analyses; this service handles the connection and interactive cards. Galaxy API operations reuse the maintained `@galaxyproject/galaxy-ops` library.

This repository is for developers and service operators. **To use the hosted service from an AI assistant, follow the [Galaxy plugin installation guide](https://github.com/goeckslab/galaxy-plugin).** Users do not need to deploy this repository, install containers or obtain an AWS account.

## Choose a setup

| Purpose | Start here |
| --- | --- |
| Develop against one test Galaxy account | [Run locally](#run-locally) |
| Operate a service for multiple users/sites | [Credential broker](docs/broker.md), then [AWS deployment](docs/aws-deployment.md) |
| Integrate a client or change tool behavior | [Tool and UI contracts](#tool-and-ui-contracts) and [validation](docs/client-compatibility.md) |

The hosted preview uses `https://mcp.galaxyproject.org/mcp`, which also serves its authorization. The original `https://mcp.galaxymcp.org/mcp` keeps serving existing connections during the move. Hosting, directory publication and client acceptance are separate milestones. See the validation guide before treating a deployment or provider as production-ready.

## Run locally

Requirements: Node.js 22, pnpm, Python 3 with Pillow, and Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) on PATH. On macOS, use `brew install poppler` and install Pillow in your Python environment. On Debian/Ubuntu, use `sudo apt-get install python3-pil poppler-utils fonts-dejavu-core`. The container image includes these tools and fonts.

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit the ignored `.env` with a test Galaxy account before starting the server:

```sh
GALAXY_URL=https://your-galaxy.example
GALAXY_API_KEY=replace-with-a-non-production-key
```

Both values are required together. Then run:

```sh
pnpm dev
```

The default endpoint is `http://127.0.0.1:8080/mcp`. This shared-key mode is for trusted single-user local development only. Keep it on loopback; never publish it through a tunnel or use it to serve independent users. The key stays on the server, outside tool arguments and responses.

### Local containers

With a working Docker-compatible runtime, such as Colima on macOS:

```sh
docker compose up --build
```

Compose publishes port 8080 only on host loopback. Set `PORT` to change the host port, for example `PORT=9090 docker compose up --build`. The container listens on its own interfaces so the container network can reach it; that does not add authentication or make public exposure safe.

## Hosted multi-user operation

Hosted operation uses Universal OAuth: the client authorizes an account, and each MCP request resolves that grant's permitted Galaxy credentials and sites. The credential broker is the separate service that manages this authorization; its [configuration guide](docs/broker.md) owns client registration, consent, token lifetimes, revocation and introspection details.

Universal mode cannot be combined with the local shared-key mode. It requires a public HTTPS origin, matching broker/resource audiences and site allowlists, persistent secrets, and registered client callbacks. `PUBLIC_BASE_URL` is an origin without credentials, path, query or fragment; the MCP resource audience adds `/mcp`. Changing the bind address alone never supplies authentication.

The hosted site list is maintained in [deploy/galaxy-instances.json](deploy/galaxy-instances.json), with its approval and consent rules in [Curated Galaxy sites](docs/broker.md#curated-galaxy-sites). Client registrations are separate from that list: a supported Galaxy site does not make every AI client eligible to connect.

Use the [AWS guide](docs/aws-deployment.md) for first deployment, routine updates and rollback. Lightsail hosts the full stack; the alternative ECS template deploys only the MCP resource server. Neither local test success nor a healthy container proves independent-user isolation, backup recovery or provider acceptance.

## Tool and UI contracts

| Area | Behavior |
| --- | --- |
| Histories and datasets | List and inspect histories, datasets, collections and provenance; create histories and upload from HTTP(S) URLs |
| Tools and workflows | Search installed tools, inspect live input templates, run tools, find/import curated IWC workflows and invoke stored workflows |
| Existing runs | Observe accepted tool requests and workflow invocations; cancellation requires destructive-action confirmation |
| Reports | Read bounded text, table, HTML/PDF and image evidence; preview datasets in the same viewer, with Galaxy summaries for unsupported files |
| Galaxy panel | Browse authorized sites, histories and reports in one manually openable view; optionally open a specific existing run |
| Run notifications | Opt in to one execution-outcome event for an existing tool request or workflow invocation |

The remote interface does not expose local-path upload/download, collection creation, direct history deletion, unrestricted account management or arbitrary user scripts. Tool availability and Galaxy permissions still depend on the selected instance.

### Site selection and pagination

Start with `get_galaxy_connections`. Galaxy operations accept `instance`; it is required when the grant includes multiple sites. `show_galaxy` can instead open an unselected workspace so the user chooses a site. Connection management applies to the authorization, not one site's data. Retain the source with each handle. Data and identifiers remain site-local; the service does not automatically transfer data between sites.

History lists default to five histories, up to 20 per request. Contents of a single history default to five items, up to 100 per request. Follow `pagination.next_offset` while `has_more` is true; page length is not a total. Filtered history-content lookup inspects at most 500 source items per call. Keep the same filters when continuing: its offset counts inspected items, not matches. An empty partial page is not proof of absence, and multiple matches require selection. History-content paging uses Galaxy's `v=dev` API rather than an unpaginated fallback.

### Submit once, then observe

`run_tool` returns an accepted request handle, not a completed analysis. Keep it and use `get_tool_request_status` for subsequent checks. An `empty` result means no jobs ran and needs input inspection. A submission timeout can have an unknown outcome; inspect existing state before considering a retry. Workflow scheduling alone is not completion: check the jobs and actual outputs.

Use `get_run_status` for a data-only status check and `show_run_status` for a visible status card. The card refreshes pending work every 15 seconds after the previous query finishes, only while the card/document are visible. Navigating away, terminal/unknown states and failures stop polling. Failed checks retain the last known snapshot until a successful manual retry. Refresh never submits work or updates the model's analysis automatically. For an older job without a tool-request or invocation handle, use `get_job_details` instead.

### Read evidence separately from requesting display

Use `get_dataset_text` for short machine-readable reports. For HTML, PDF or longer text, call `read_dataset_report` with the resolved `datasetId`. Follow `next_offset` within a page; when following `next_page`, reset `offset` to zero. Compare `source_sha256` across reads to avoid combining excerpts from changed outputs.

HTML extraction retains text, headings and tab-separated table cells. `figures` lists up to 100 image candidates; `includeImage: true` with an available `imageIndex` requests an embedded raster image. PDF extraction returns one page at a time; `includeImage` renders that page at up to 2,000 pixels. The service does not run OCR or another LLM. Use numerical source data for exact calculations, not estimates from plots.

Reads accept completed, non-deleted datasets from the authenticated connection. UTF-8 text is supported without a datatype whitelist, including JSON, XML, Markdown and scientific text formats. Gzip text is decompressed with a 20 MB expansion limit. PNG, JPEG, GIF, WebP, BMP and TIFF are decoded into bounded raster previews; multi-frame files can be inspected frame by frame. Static SVG and small native audio/video previews are UI-only, not model-visible visual or transcript evidence. Binary formats are never presented as decoded text.

Limits are 20 MB source, 50,000 returned characters, one optional image up to 2 MB and two simultaneous readers, with bounded download/decoder time and memory. Raster input is limited to 16 million pixels. Table previews have at most 50 rows, 50 columns and 2,000 characters per cell; source text remains separately available. Redirects and arbitrary asset URLs are not followed. Temporary files are removed after each request; interrupted processes may leave files until container recreation. Credentials are not passed to the decoder. Returned limitations identify omitted visuals, external content and incomplete extraction; source content is untrusted data, not instructions.

`get_histories` and `get_history_contents` read data without creating cards. Use `show_histories` when the user needs a history selector, or `show_history` to browse one history's outputs. Both lists initially display at most five rows. Load more reveals or fetches the next five; Load less collapses the list without fetching again. Navigation preserves the expanded list. A history is listed as Galaxy's history panel lists it: hidden and deleted items are left out, and `show_history` puts the newest item first. `get_history_contents` lists oldest first unless `order` says otherwise, so that offsets stay valid while a run adds items; `visible: false` or `deleted: true` lists the hidden or the deleted items instead. The default guidance is one useful card per response, not a card for every intermediate lookup, result or polling step.

`show_dataset` requests a standalone card for a known completed dataset when needed. All completed, non-deleted datasets have a details entry; this does not mean the card implements every Galaxy datatype-specific application. The same viewer provides static HTML, PDF pages, images, CSV/TSV tables, formatted JSON and plain/structured text, with page/text navigation and horizontal scrolling. Unsupported, oversized or binary files use Galaxy's own `peek` summary and metadata, with an original-file link for specialized viewers or download. Collections remain separate from dataset files.

Previews contain no nested report frames, source scripts/styles or external assets. SVG is sanitized and displayed in native image mode. Audio/video controls never autoplay and are limited to 2 MB; codec and sandbox support depend on the host. The original-file link opens Galaxy separately and may require sign-in. A loaded summary or preview is not proof that all file content was read.

Cards use the standard MCP Apps bridge; OpenAI globals are optional compatibility fallbacks. Successful presentation requests return `presentation.display_status: unconfirmed`; ordinary data reads do not request presentation. UI feedback is correlated through `presentation.view_id`, retains `display_verified: false` and does not contain the report evidence. Even when a host accepts `ui/update-model-context`, that is not proof the user saw a card. The model must read evidence separately before interpreting it. Tools-only clients receive text and structured results without needing a renderer. After deploying changes to tool names or UI metadata, refresh the developer-mode tool catalog and update the review snapshot; a client holding old definitions can still request the old rendering behavior.

### Manually openable Galaxy panel

`show_galaxy` reuses the same MCP Apps resource as the cards. Its `openai/ui.entrypoints` metadata registers global and thread entrypoints for clients supporting [Plugin Extensions](https://developers.openai.com/plugins/build/extensions). Users can open the panel without asking for a new card, choose an authorized site, browse five histories at a time, inspect supported reports and open connection management. Navigation reads data in place rather than rendering another chat card. Selection context identifies the site and selected history, report or run; it is not a substitute for reading result evidence.

Calling `show_galaxy` with `instance`, `kind` and `runId` opens the status of that existing analysis in the panel. Without a run, it opens history browsing. Multiple sites require an explicit choice; switching sites clears the previous selection and rejects stale or mismatched responses. This panel does not list every past tool run or automatically infer the analysis relevant to a chat.

The global/thread entrypoints require host support. Other MCP Apps clients can render the same view when the tool is invoked; tools-only clients still receive structured results. No provider-specific sidebar is promised for Claude. These entrypoints need a deployment, client catalog refresh and real-client acceptance testing before being advertised as available on the hosted service.

### Opt-in execution-outcome notifications

In broker-authenticated mode, MCP 2.0 clients can discover `galaxy.run.outcome` through `events/list`, then subscribe with an explicit `instance`, `kind` and existing `runId`. For example, a user can ask, “Notify me when this Galaxy analysis finishes or fails.” The client supplies its verified HTTPS callback and signing secret; users do not configure a webhook or paste secrets into chat. Never subscribe automatically or monitor all future analyses.

The event reports one observed execution outcome: `completed`, `failed`, `cancelled` or `empty`. It includes the source site, run name and handle, check time and available history link. Completion does not validate scientific findings; a detected failure may occur while other jobs continue. Temporary query failures are not reported as failed analyses. Subscriptions observe existing work only; they never submit, restart or cancel an analysis and do not automatically rewrite an old card.

Subscriptions persist encrypted in the broker database, bound to the exact OAuth grant rather than a ten-minute access token or browser cookie. The default and maximum subscription lifetime is 24 hours, capped by the grant's remaining lifetime. The client renews before `refreshBefore`; renewal preserves pending and acknowledged outcomes. Delivery is at-least-once, with stable event IDs and up to five transient delivery attempts. Receivers must deduplicate those IDs. `events/unsubscribe`, removal of the selected site, expiry or grant revocation stops delivery; none cancels a Galaxy job. See [broker security and delivery behavior](docs/broker.md#run-event-subscriptions).

The protocol and callback behavior follow [MCP Events in ChatGPT](https://developers.openai.com/plugins/build/mcp-events). Standard MCP tools and cards remain usable by clients without Events. Deploy the broker and MCP server together, rescan the catalog and test a real ChatGPT subscription before claiming hosted notification availability. Directory approval and deployment are separate.

## Development and operations

Run `pnpm check` for lint, type and service checks; see [validation prerequisites and commands](docs/client-compatibility.md#run-the-automated-checks) for broker and deployment tests. CI builds the container for `linux/amd64` without Galaxy credentials; it does not deploy infrastructure.

The ops dependency is pinned to npm `0.1.0`, with a [temporary patch](patches/@galaxyproject__galaxy-ops@0.1.0.patch) for nested input templates, numeric constraints and resumable requests. Remove the patch when an official dependency release includes the fixes; do not copy the upstream library into this repository.

`POST /mcp` is the stateless tool endpoint; `GET /healthz` checks process health and `GET /readyz` checks readiness. Neither health route proves a successful client login or Galaxy analysis. Logs must contain protocol metadata only, never credentials, authorization headers, user/report content or credential-bearing URLs.

Source layout: `apps/service/` contains HTTP/MCP tools and cards; `apps/broker/` contains authorization and encrypted persistence; `packages/protocol/` contains shared validation and logging; `tests/` contains automated checks. Deployment files are in `deploy/`.
