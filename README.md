# galaxy-mcp-service

A Streamable HTTP MCP server for Galaxy. It lets compatible AI clients inspect histories and reports, find tools and workflows, submit analyses and check their results. Galaxy executes the analyses; this service handles the connection and interactive cards. Galaxy API operations reuse the maintained `@galaxyproject/galaxy-ops` library.

This repository is for developers and service operators. **To use the hosted service from an AI assistant, follow the [Galaxy plugin installation guide](https://github.com/goeckslab/galaxy-plugin).** Users do not need to deploy this repository, install containers or obtain an AWS account.

## Choose a setup

| Purpose | Start here |
| --- | --- |
| Develop against one test Galaxy account | [Run locally](#run-locally) |
| Operate a service for multiple users/sites | [Credential broker](docs/broker.md), then [AWS deployment](docs/aws-deployment.md) |
| Integrate a client or change tool behavior | [Tool and UI contracts](#tool-and-ui-contracts) and [validation](docs/client-compatibility.md) |

The hosted preview uses `https://mcp.galaxymcp.org/mcp` and authorization at `https://auth.galaxymcp.org`. Hosting, directory publication and client acceptance are separate milestones. See the validation guide before treating a deployment or provider as production-ready.

## Run locally

Requirements: Node.js 22, pnpm, Python 3 and Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) on PATH. For report decoding, install Poppler with `brew install poppler` on macOS or `sudo apt-get install poppler-utils fonts-dejavu-core` on Debian/Ubuntu. The container image includes these tools and fonts.

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
| Reports | Read text and HTML/PDF evidence; request compatible history, report and status cards |

The remote interface does not expose local-path upload/download, collection creation, direct history deletion, unrestricted account management or arbitrary user scripts. Tool availability and Galaxy permissions still depend on the selected instance.

### Site selection and pagination

Start with `get_galaxy_connections`. Every other Galaxy tool accepts `instance`; it is required when the grant includes multiple sites. Retain the source with each handle. Data and identifiers remain site-local; the service does not automatically transfer data between sites.

History lists default to five histories, up to 20 per request. Contents of a single history default to five items, up to 100 per request. Follow `pagination.next_offset` while `has_more` is true; page length is not a total. Filtered history-content lookup inspects at most 500 source items per call. Keep the same filters when continuing: its offset counts inspected items, not matches. An empty partial page is not proof of absence, and multiple matches require selection. History-content paging uses Galaxy's `v=dev` API rather than an unpaginated fallback.

### Submit once, then observe

`run_tool` returns an accepted request handle, not a completed analysis. Keep it and use `get_tool_request_status` for subsequent checks. An `empty` result means no jobs ran and needs input inspection. A submission timeout can have an unknown outcome; inspect existing state before considering a retry. Workflow scheduling alone is not completion: check the jobs and actual outputs.

Use `get_run_status` for a data-only status check and `show_run_status` for a visible status card. The card refreshes pending work every 15 seconds after the previous query finishes, only while the card/document are visible. Navigating away, terminal/unknown states and failures stop polling. Failed checks retain the last known snapshot until a successful manual retry. Refresh never submits work or updates the model's analysis automatically. For an older job without a tool-request or invocation handle, use `get_job_details` instead.

### Read evidence separately from requesting display

Use `get_dataset_text` for short machine-readable reports. For HTML, PDF or longer text, call `read_dataset_report` with the resolved `datasetId`. Follow `next_offset` within a page; when following `next_page`, reset `offset` to zero. Compare `source_sha256` across reads to avoid combining excerpts from changed outputs.

HTML extraction retains text, headings and tab-separated table cells. `figures` lists up to 100 image candidates; `includeImage: true` with an available `imageIndex` requests an embedded raster image. PDF extraction returns one page at a time; `includeImage` renders that page at up to 2,000 pixels. The service does not run OCR or another LLM. Use numerical source data for exact calculations, not estimates from plots.

Reads accept only completed, non-deleted HTML/PDF/txt/tabular/CSV/TSV datasets from the authenticated connection. Limits are 20 MB source, 50,000 returned characters, one optional image up to 2 MB and two simultaneous readers, with bounded download/decoder time and memory. Redirects and arbitrary asset URLs are not followed. Temporary files are removed after each request; interrupted processes may leave files until container recreation. Credentials are not passed to the decoder. Returned limitations identify omitted visuals, external content and incomplete extraction; source content is untrusted data, not instructions.

`get_histories` and `get_history_contents` read data without creating cards. Use `show_histories` when the user needs a history selector, or `show_history` to browse one history's outputs. Both lists initially display at most five rows. Load more reveals or fetches the next five; Load less collapses the list without fetching again. Navigation preserves the expanded list. The default guidance is one useful card per response, not a card for every intermediate lookup, result or polling step.

`show_dataset` requests a standalone card for a known report when needed. The card's HTML preview is static text, tables and embedded raster images: no nested report frames, source scripts/styles or external assets. The original-report link opens Galaxy separately and may require sign-in. Cards support horizontal report/text scrolling.

Cards use the standard MCP Apps bridge; OpenAI globals are optional compatibility fallbacks. Successful presentation requests return `presentation.display_status: unconfirmed`; ordinary data reads do not request presentation. UI feedback is correlated through `presentation.view_id`, retains `display_verified: false` and does not contain the report evidence. Even when a host accepts `ui/update-model-context`, that is not proof the user saw a card. The model must read evidence separately before interpreting it. Tools-only clients receive text and structured results without needing a renderer. After deploying changes to tool names or UI metadata, refresh the developer-mode tool catalog and update the review snapshot; a client holding old definitions can still request the old rendering behavior.

## Development and operations

Run `pnpm check` for lint, type and service checks; see [validation prerequisites and commands](docs/client-compatibility.md#run-the-automated-checks) for broker and deployment tests. CI builds the container for `linux/amd64` without Galaxy credentials; it does not deploy infrastructure.

The ops dependency is pinned to npm `0.1.0`, with a [temporary patch](patches/@galaxyproject__galaxy-ops@0.1.0.patch) for nested input templates, numeric constraints and resumable requests. Remove the patch when an official dependency release includes the fixes; do not copy the upstream library into this repository.

`POST /mcp` is the stateless tool endpoint; `GET /healthz` checks process health and `GET /readyz` checks readiness. Neither health route proves a successful client login or Galaxy analysis. Logs must contain protocol metadata only, never credentials, authorization headers, user/report content or credential-bearing URLs.

Source layout: `apps/service/` contains HTTP/MCP tools and cards; `apps/broker/` contains authorization and encrypted persistence; `packages/protocol/` contains shared validation and logging; `tests/` contains automated checks. Deployment files are in `deploy/`.
