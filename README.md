# galaxy-mcp-service

`galaxy-mcp-service` is a Streamable HTTP MCP server that lets compatible clients inspect data, find and run tools, and work with workflows on Galaxy. It uses the maintained `@galaxyproject/galaxy-ops` package rather than duplicating Galaxy API logic.

## Capabilities

- Inspect the connected server and current user.
- List histories, inspect history contents, datasets, and collections, and create histories.
- Read a bounded excerpt from completed txt, tabular, CSV, or TSV analysis results.
- Upload a dataset from an HTTP(S) URL.
- Search installed tools, inspect schemas and examples, submit tools once, and resume checks through `get_tool_request_status`.
- List and inspect workflows, build input templates, invoke workflows, monitor invocations, and cancel an invocation with destructive-action confirmation.
- Search and recommend curated IWC workflows, inspect them, and import one into Galaxy.
- Browse recent histories, paginated results, and reports in a dependency-free MCP Apps card. Back navigation preserves the expanded list; text and HTML reports support horizontal scrolling.
- Show an existing tool request or workflow invocation with `get_run_status`: human-readable state, observed job counts, last-check time, available failure details, and a link into the existing history browser. Refresh is read-only and never reruns the analysis.

The HTML viewer disables scripts, forms, external links, and external network access while preserving safe report-internal links and SVG references. Raw report HTML is delivered only to the app component, not to the model. Server-local upload and download paths, collection creation, unrestricted account-management operations, and direct history deletion are intentionally not exposed to remote clients.

In version 0.3, `run_tool` returns an accepted request handle, not a completed analysis. Keep that handle and call `get_tool_request_status` until terminal; a transient status error includes recovery information and does not authorize resubmission. An `empty` run created no jobs and needs input inspection, not indefinite polling. A submission timeout can have an unknown outcome and must not be retried blindly. History pages default to 20 items (maximum 100); follow `pagination.next_offset` while `has_more` is true. The service never labels a history page's length as its total.

Use `get_run_status` when a visible status card is useful; execution and background status tools remain data-only so repeated checks do not create repeated cards. This follows the [OpenAI guidance on separating data processing from rendering](https://developers.openai.com/plugins/build/chatgpt-ui#separate-data-processing-from-ui-rendering). The card refreshes only on request, preserves its previous snapshot when a check fails, and never estimates a percentage. Workflow scheduling alone is not completion: its own job summary must confirm successful execution. The history button opens the containing history, which may include other runs. An old job ID without a tool-request or invocation handle is not supported by this card; inspect it with `get_job_details` instead.

## Run locally

Requirements: Node.js 22 and pnpm.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Set the Galaxy connection in `.env`:

```sh
GALAXY_URL=https://your-galaxy.example
GALAXY_API_KEY=replace-with-a-non-production-key
```

Both values must be present together. The API key remains server-side and is never accepted as a tool argument or returned to the client.

## Universal deployment

Production uses one fixed public `/mcp` URL for every user. Configure an OAuth 2.1 authorization server or credential broker that handles login and Galaxy-instance selection, stores each user's Galaxy credential, and exposes RFC 7662 token introspection. The MCP service validates every bearer token and resolves the returned instance ID through a server-owned allowlist.

```sh
PUBLIC_BASE_URL=https://mcp.example.org
OAUTH_METADATA_URL=https://auth.example.org/.well-known/oauth-authorization-server
OAUTH_INTROSPECTION_CLIENT_ID=galaxy-mcp
OAUTH_INTROSPECTION_CLIENT_SECRET=replace-with-a-secret
GALAXY_INSTANCES_JSON='{"main":"https://usegalaxy.org","eu":"https://usegalaxy.eu"}'
```

The authorization-server metadata must advertise authorization code, PKCE `S256`, a ChatGPT-compatible token authentication method, the `galaxy:full` scope, and an `introspection_endpoint` that supports `client_secret_basic`. ChatGPT supports CIMD, dynamic registration, or a pre-registered OAuth client; configure the corresponding client method in the connector. A successful introspection response must include standard `active`, `sub`, `client_id`, `scope`, `exp`, `iss`, and `aud` fields plus `galaxy_instance` and `galaxy_api_key`. `aud` must exactly match `PUBLIC_BASE_URL` with `/mcp`; `galaxy_instance` must be a key in `GALAXY_INSTANCES_JSON`. The broker must issue opaque access tokens that contain no Galaxy credential, and it must bind the selected instance and API key to `sub` for the token lifetime. Galaxy credentials are never accepted as tool arguments. See the [OpenAI authentication contract](https://developers.openai.com/plugins/build/auth).

This repository implements the OAuth resource server, **not the credential broker**. Public launch still requires a deployed broker with login/consent, encrypted persistent credential storage, token refresh and revocation; a stable HTTPS domain; and two-account, two-instance validation. Passing the local tests does not establish production readiness.

Universal mode and the local shared `GALAXY_URL`/`GALAXY_API_KEY` mode are mutually exclusive. The OAuth provider must publish its own discovery endpoint and support authorization code with PKCE; configure OpenID Connect `openid`, `email`, and a UserInfo endpoint when workspace domain restrictions are required.

The service listens on `0.0.0.0:8080` by default:

| Route | Purpose |
| --- | --- |
| `POST /mcp` | Stateless Streamable HTTP MCP endpoint |
| `GET /healthz` | Process health |
| `GET /readyz` | Service readiness |

Local clients can connect to `http://127.0.0.1:8080/mcp`. ChatGPT requires an OpenAI Secure MCP Tunnel because it cannot reach loopback directly.

## Docker

```sh
docker compose up --build
```

Compose publishes port `8080`. Override the host port with `PORT`, for example `PORT=9090 docker compose up --build`.

`PUBLIC_BASE_URL` is optional for loopback use and required when requests arrive with a non-loopback host. It must be an externally reachable HTTP(S) origin without credentials, path, query, or fragment.

## Development

```sh
pnpm check
docker build -t galaxy-mcp-service:check .
```

Structured logs contain protocol metadata only and must never contain API keys, bearer tokens, user content, file contents, or credential-bearing URLs. The environment-variable Galaxy connection is for single-user local development only; Universal OAuth mode provides request-scoped, allowlisted multi-instance routing.

The checked-in CI workflow runs the same checks and builds the container without Galaxy credentials. It does not deploy infrastructure. The ops dependency remains pinned to npm `0.1.0`, with a [temporary dependency patch](patches/@galaxyproject__galaxy-ops@0.1.0.patch) for nested input templates, numeric constraints, and resumable tool requests. These fixes were made in the upstream library source; remove the patch when an official release includes them.

## Repository layout

```text
apps/service/       HTTP server, MCP tools, and history UI
packages/protocol/  request validation and safe protocol logging
tests/              unit, contract, and integration checks
docs/               client validation notes
```
