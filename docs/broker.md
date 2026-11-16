# Galaxy credential broker

The broker is a separate OAuth authorization server for the Galaxy MCP service. It lets a user authorize one or more approved Galaxy servers with their own server-specific API keys. The AI client receives opaque OAuth tokens, not Galaxy keys. The MCP resource server retrieves the authorized credentials through authenticated token introspection.

This guide is for operators configuring or maintaining the authorization service. It owns the credential, consent and token contracts; use the [AWS guide](aws-deployment.md) for infrastructure and release commands. Users connecting an account should use the [Galaxy plugin installation guide](https://github.com/goeckslab/galaxy-plugin).

The implementation uses pinned `oidc-provider` for OAuth and PostgreSQL for durable state. The Lightsail stack runs the broker alongside MCP; the alternative ECS resource-server template does not deploy it. A new deployment needs HTTPS, a durable database, protected persistent secrets, registered clients and published operator/privacy information.

## Start the broker

Install workspace dependencies and build with `pnpm install --frozen-lockfile` and `pnpm build`. Supply the following environment variables, then run `pnpm start:broker`. The command reads the process environment; it does not automatically load an `.env` file. For local development with an ignored `.env`, use `pnpm --filter @galaxy-mcp-service/broker dev`.

| Variable | Required value |
| --- | --- |
| `BROKER_ISSUER` | The broker's HTTPS origin, without a path or trailing slash. |
| `BROKER_RESOURCE` | The exact public MCP endpoint, including `/mcp`. |
| `BROKER_DATABASE_URL` | PostgreSQL connection URL for a dedicated broker database. Use authenticated, certificate-verified TLS for remote PostgreSQL. |
| `BROKER_ENCRYPTION_KEY` | Base64 encoding of 32 cryptographically random bytes. Keep this key stable and backed up separately from the database. |
| `BROKER_COOKIE_KEYS_JSON` | JSON array of strong, random signing-key strings, at least 32 bytes each. The first signs new cookies; previous keys can remain during rotation. |
| `BROKER_JWKS_JSON` | A private signing JWK set, with a stable key ID and algorithm, such as an RSA key of at least 2048 bits using `RS256`. |
| `BROKER_CLIENTS_JSON` | JSON array of explicitly registered application clients; see below. |
| `BROKER_RESOURCE_CLIENT_ID` | A distinct client ID used only by the MCP resource server. |
| `BROKER_RESOURCE_CLIENT_SECRET` | A strong secret of at least 32 characters for that resource client. |
| `GALAXY_INSTANCES_JSON` | JSON object mapping approved instance names to canonical HTTPS Galaxy base URLs. Use the same mapping on the MCP service. |

Generate production secrets using the deployment's secret-management process. Do not put them in source control, build arguments, shell history, screenshots or logs. Do not generate new encryption, cookie or signing keys on each process start. Changing the encryption key makes existing state inaccessible; this implementation does not provide online encryption-key migration. Keep compatible signing and cookie key history when rotating those keys.

Instance names use lowercase letters, digits, `_` and `-`, beginning with a letter or digit. Instance URLs may contain a Galaxy installation path, but no query, fragment or embedded credentials. The broker never accepts an arbitrary Galaxy URL from the login form. It never reads a shared `GALAXY_API_KEY`.

`HOST` defaults to `127.0.0.1` and `PORT` to `8081`. The shared container image defaults to the MCP service; run the same image with command `node apps/broker/dist/index.js` to start the broker instead. Its container port defaults to `8080` through the existing image environment.

For isolated loopback development only, `BROKER_ALLOW_LOOPBACK=1` permits HTTP URLs on `localhost`, `127.0.0.1` or `::1`. Leave it unset in a public deployment.

Behind a trusted TLS-terminating proxy, set `BROKER_TRUST_PROXY=1` and restrict direct broker access to that proxy. The proxy must preserve the public Host, overwrite the forwarded protocol, and append the actual peer IP. The broker uses the nearest forwarded IP for its login limiter. Do not expose a proxy-trusting broker directly to untrusted traffic.

OAuth and interaction routes reject an unexpected Host or external HTTP origin. The exact `GET /readyz` route is exempt so container and load-balancer probes work without a public Host header; it checks database connectivity and returns only readiness status. It does not test client login or Galaxy connectivity.

## Register an AI client

Claude's hosted clients (Web, Desktop, mobile and Cowork) can use **Use Claude's published identity** without an operator-created client ID or secret. The broker enables the pinned OAuth library's Client ID Metadata Document (CIMD) support and advertises `client_id_metadata_document_supported: true` together with the public-client token authentication method `none`. Dynamic client registration (DCR) is not enabled; do not select **Register automatically**.

CIMD retrieval is restricted to HTTPS metadata under `https://claude.ai/oauth/`, without credentials, query strings or fragments. The library enforces bounded requests and response sizes, rejects redirects, validates the document's exact `client_id`, and caches metadata. Accepted clients must be public, use only authorization-code/refresh-token grants and code responses, and declare only the hosted callback `https://claude.ai/api/mcp/auth_callback`. PKCE `S256`, explicit consent and grant-bound Galaxy credentials still apply. The consent screen shows the trusted metadata hostname and callback hostname instead of trusting a document's display name. See [Claude's authentication requirements](https://claude.com/docs/connectors/building/authentication).

Existing explicitly registered clients, including ChatGPT and the earlier native connection, continue to use `BROKER_CLIENTS_JSON`. The broker also includes seven reviewed public-client profiles. An operator's explicit registration for the same ID takes precedence. These profiles are connection support, not directory listings or user grants:

| Client | Public client ID | Registered callbacks |
| --- | --- | --- |
| Codex | `https://chatgpt.com/oauth/codex/client.json` | `http://127.0.0.1/callback`, `http://localhost/callback` |
| Claude Code | `https://claude.ai/oauth/claude-code-client-metadata` | `http://localhost/callback`, `http://127.0.0.1/callback` |
| VS Code / GitHub Copilot | `https://vscode.dev/oauth/client-metadata.json` | `http://127.0.0.1/`, `https://vscode.dev/redirect` |
| Cursor | `galaxy-cursor` | `http://localhost:8787/callback`, `https://www.cursor.com/agents/mcp/oauth/callback` |
| Gemini CLI | `galaxy-gemini-cli` | `http://localhost/oauth/callback` |
| Grok Build | `galaxy-grok-build` | `http://localhost/callback`, `http://127.0.0.1/callback` |
| Grok | `https://grok.com/oauth/mcp-client.json` | `https://grok.com/connectors-oauth-exchange-code/`, `https://console.x.ai/connectors-oauth-exchange-code/` |

The pinned library applies RFC 8252 port-agnostic matching to native HTTP loopback callbacks; host and path must still match. HTTPS callbacks remain exact. The broker advertises RFC 9207 issuer identification and includes `iss` in authorization responses. This allows Codex to use its stable published identity and callback; arbitrary callback-ID-specific documents are not accepted. None of these public clients needs a client secret, and every connection still requires S256 PKCE and explicit consent for the selected Galaxy accounts.

The four URL IDs are **pre-registered profiles**; they do not enable arbitrary metadata fetching. Claude Code's current document omits the OIDC `application_type` needed for variable loopback ports; VS Code's document also declares device-code flow. The registrations explicitly identify those clients as native and allow only authorization-code and rotating refresh flows. Grok is a public web client with exact HTTPS callbacks. This avoids modifying vendor documents or enabling an unused grant. Review their official identities and callbacks when upgrading clients: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Claude authentication](https://claude.com/docs/connectors/building/authentication), [VS Code identity](https://vscode.dev/oauth/client-metadata.json), [Cursor MCP](https://cursor.com/docs/mcp), [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/), and [Grok identity](https://grok.com/oauth/mcp-client.json).

### Connect a supported client

Use the hosted URL `https://mcp.galaxyproject.org/mcp` for the Galaxy deployment; self-hosters substitute their own HTTPS MCP URL. These examples describe native HTTP connections, not a requirement to run Galaxy or the MCP service locally. A successful local protocol test does not prove acceptance in every client version.

**Codex** can select its published identity from discovery:

```sh
codex mcp add galaxy --url https://mcp.galaxyproject.org/mcp
codex mcp login galaxy
```

**Claude Code** can use its own published identity:

```sh
claude mcp add --transport http galaxy https://mcp.galaxyproject.org/mcp
```

Then authenticate Galaxy in Claude Code's `/mcp` menu. The earlier `galaxy-claude-code` static registration remains supported for existing plugin installations.

**VS Code / GitHub Copilot** can use its published identity, or this explicit client ID in its MCP configuration:

```json
{"servers":{"galaxy":{"type":"http","url":"https://mcp.galaxyproject.org/mcp","oauth":{"clientId":"https://vscode.dev/oauth/client-metadata.json"}}}}
```

**Cursor** uses a pre-registered public ID in its MCP configuration:

```json
{"mcpServers":{"galaxy":{"url":"https://mcp.galaxyproject.org/mcp","auth":{"CLIENT_ID":"galaxy-cursor","scopes":["galaxy:full","offline_access"]}}}}
```

**Gemini CLI** uses a pre-registered public ID in its settings:

```json
{"mcpServers":{"galaxy":{"httpUrl":"https://mcp.galaxyproject.org/mcp","oauth":{"enabled":true,"clientId":"galaxy-gemini-cli","scopes":["galaxy:full","offline_access"]}}}}
```

**Grok** users can open [Connectors](https://grok.com/connectors), choose **New Connector → Custom**, enter the name `Galaxy` and the hosted MCP URL, then authenticate. Grok supplies its reviewed public identity automatically; no client ID or secret needs to be entered. Team policy may require an administrator to enable custom connectors. Authorization still requires the user's explicit Galaxy consent. See [Grok's connector guide](https://docs.x.ai/grok/connectors).

**Grok Build** uses the plugin's native HTTP connection with the separate `galaxy-grok-build` public native registration. No local connection adapter is required. Its consent page identifies Grok Build, not Claude Code. The CLI and Grok.com have separate client IDs and grants. See the [Grok Build installation guide](https://github.com/goeckslab/galaxy-plugin/blob/main/docs/grok.md).

Gemini CLI support is not a claim that the Gemini consumer chat can use this configuration. Similarly, local clients may use different model providers without needing a separate registration for each model. Interactive cards additionally require an MCP Apps renderer; native tool connectivity alone does not guarantee cards or a ChatGPT-style Workspace.

[Mistral](https://docs.mistral.ai/studio/connectors/management) documents custom MCP connections. Its production OAuth identity and callbacks have not yet been verified for this service, so it is not added to the allowlist or claimed as tested. API remote-MCP support is separate from a hosted chat's interactive OAuth connection. Do not guess callback URLs or enable unrestricted registration to bypass this gap.

For each client, obtain its actual redirect URI from its connector setup or official client documentation. Register that exact URI, not a wildcard. Configure authorization-code flow with PKCE `S256`. A public native client's registration has this shape:

```json
[
  {
    "client_id": "example-native-client",
    "client_name": "Example native client",
    "application_type": "native",
    "token_endpoint_auth_method": "none",
    "redirect_uris": ["http://127.0.0.1/callback"]
  }
]
```

The callback above is illustrative, not a universal callback. A confidential web client instead needs its real HTTPS callback, `application_type: "web"`, a strong `client_secret`, and a supported method such as `client_secret_basic`. The broker restricts application registrations to authorization-code and refresh-token grants with the `galaxy:full` scope. Never give application clients the resource-server client ID or secret.

The advertised `openid` scope is enabled for application clients and consented grants. Clients that request it receive a signed identity token with an instance-bound, pseudonymous subject, not a Galaxy key or email address. Galaxy access still requires an opaque access token for the MCP resource.

For ordinary `GET /auth` requests that omit `scope`, the broker uses the predefined `galaxy:full` default, as permitted by [OAuth 2.0 section 3.3](https://www.rfc-editor.org/rfc/rfc6749#section-3.3). Explicit scopes and signed/request-URI authorization requests are not expanded. The default does not bypass the consent form: users must still approve reading and running analyses for their selected Galaxy accounts, with the same 30-day maximum connection lifetime and PKCE protections.

Point the client at the broker's discovery document, `/.well-known/oauth-authorization-server`. Authorization and token endpoints are `/auth` and `/token`. Configure the existing MCP service with:

- `OAUTH_METADATA_URL`: the broker origin plus `/.well-known/oauth-authorization-server`.
- `OAUTH_INTROSPECTION_CLIENT_ID` and `OAUTH_INTROSPECTION_CLIENT_SECRET`: the dedicated resource-client credentials.
- `PUBLIC_BASE_URL`: the public MCP origin; its `/mcp` URL must equal `BROKER_RESOURCE`.
- `GALAXY_INSTANCES_JSON`: the same canonical allowlist used by the broker.

The metadata must advertise authorization code, PKCE `S256`, `galaxy:full` and an introspection endpoint supporting `client_secret_basic`. Active introspection responses must contain `sub`, `client_id`, `scope`, `exp`, `iss` and `aud`; the audience must exactly match the MCP resource URL. Credential fields depend on whether the grant contains one site or multiple sites, as specified below. The resource server checks these fields before calling Galaxy. Workspace email/domain restrictions require additional verified-email identity support; the broker's pseudonymous `openid` subject is not an email address.

## Curated Galaxy sites

The hosted common-site list is maintained in [deploy/galaxy-instances.json](../deploy/galaxy-instances.json): US (`us`), Europe (`eu`), Australia (`au`), France (`fr`) and Canada (`ca`). These five public servers appear in the [Galaxy account guide](https://training.galaxyproject.org/training-material/faqs/galaxy/account_create.html). The directory is a discovery source, not an automatically trusted registry.

The authorization page labels `https://usegalaxy.org` as **US**. Form submissions, saved grants and MCP calls all use the `us` alias. Discover the current authorized aliases with `get_galaxy_connections` before selecting a site.

Users can [request another site through GitHub Issues](https://mcp.galaxyproject.org/support#request-site). Requests are public and should include the canonical HTTPS URL, institution, public operator contact and intended non-sensitive research use, never credentials or private data. Posting a request does not create a connection or enable a site automatically. The publisher reviews the public endpoint and API compatibility before enabling it. Private-network endpoints are outside this hosted list. Account-specific privacy and deletion requests use the separate [private contact form](https://mcp.galaxyproject.org/support#private-contact), not public Issues.

Both MCP and broker must use the same approved map. The [release command](aws-deployment.md#routine-mcp-updates) supports reviewed additions with configuration rollback; existing aliases cannot be removed or remapped through that command. Adding a site does not expand saved grants. Users authorize their own account separately for each newly selected site.

## Connection lifetime and revocation

Every authorization requires the broker's own explicit consent form. Enter a key only for each intended server; blank fields grant no access. Up to ten sites can be authorized together, with one account per site. All selected keys are verified through bounded, read-only current-user requests before any grant is saved. If any verification fails, no partial connection is created.

Identity is derived from the selected canonical Galaxy URLs and their user IDs, so identical IDs on different servers remain separate identities. A new authorization creates an immutable grant-bound credential record containing the selected connection set. Reconnecting does not expand, retarget or revoke an older grant: revoke the old grant separately when replacing it. The encrypted payload carries the connection set, including when only one site is selected.

After consent or cancellation, the form response completes with a script-free page that automatically continues to the provider's validated same-origin resume URL, with a manual link as fallback. This separates form submission from the subsequent client callback: browsers can enforce `form-action 'self'` without blocking the OAuth redirect. The key is never included in the continuation page or URL, and client callbacks remain exactly registered and PKCE-protected.

The login form uses `Referrer-Policy: same-origin`: native browser form submissions retain the origin needed by the strict CSRF origin check, while cross-origin navigation sends no referrer. Continuation and other responses retain `no-referrer`. Null, absent and foreign form origins are rejected; do not relax this validation to fix browser login failures.

Access tokens last 10 minutes. Connections have a fixed maximum lifetime of 30 days; refresh tokens rotate on each use, and replay revokes their entire grant. Losing a browser session does not revoke an explicitly consented connection. Expired records are rejected immediately and pruned from the live database periodically; backup retention must be specified by the operator.

## Run event subscriptions

The MCP server exposes opt-in `galaxy.run.outcome` notifications only with broker authentication and MCP protocol `2026-07-28`. The broker discovery document advertises the deployment-specific `galaxy_run_events_supported` flag; the MCP server does not start a worker or advertise Events when that flag is absent. This avoids advertising unavailable subscription storage during a mixed-version rollout. Subscriptions select one authorized site and an existing tool request or workflow invocation. They do not authorize new sites, launch analyses or extend the underlying Galaxy grant.

The broker's internal `/events/prepare`, `/events/subscribe`, `/events/unsubscribe`, `/events/claim`, `/events/check` and `/events/save` endpoints require the dedicated resource-client credentials. Creation and removal also require the user's current OAuth access token. These are server-to-server endpoints, not browser management links. Do not expose resource-client credentials to an AI client.

Subscription identity includes the exact grant, normalized callback URL, event name and canonical arguments. A new grant for the same Galaxy account cannot renew or delete another grant's subscription. Signing secrets, callback URLs, arguments and pending event payloads use the existing AES-256-GCM database encryption. No user access token or additional Galaxy key is stored in a subscription. The credential record remains the source of current site access. At most 50 subscriptions are retained per grant, each for up to 24 hours or the grant's remaining lifetime, whichever is shorter.

The MCP server verifies a signed, fresh callback challenge before activating a subscription. Verification can be reused for five minutes only for the same grant, arguments, callback and secret. Each verification and delivery resolves all DNS answers, rejects non-public addresses, pins the chosen address while preserving HTTPS hostname verification, follows no redirects and has a ten-second deadline. Callback signing uses the Standard Webhooks HMAC format; rotation briefly signs with both keys for 60 seconds. Callback secrets and payloads are never logged.

Database row leases serialize concurrent workers. An observed outcome is persisted before delivery, retaining the exact event ID and body across failures and restarts. Normal run-status checks occur at most once per minute per subscription; unknown states and temporary failures do not create failure events. Transient delivery failures use bounded exponential backoff; `410` and `413` stop immediately. Five unsuccessful pending-outcome attempts stop delivery until a new subscription identity is created. Acknowledged outcomes are not repeated by renewal. This is at-least-once delivery, not exactly-once delivery.

Each delivery rechecks the broker grant/site and readable Galaxy run. Removing a site deletes its subscriptions in the same transaction; revoking a grant deletes all its subscriptions through the credential foreign key. Expiry rejects access immediately. A callback already in flight cannot be recalled. Browser cookie deletion has no effect on these grant-bound subscriptions.

Deploy the broker before or together with the MCP server when introducing Events. The existing PostgreSQL database is sufficient; no extra queue, account system or paid infrastructure is required. Local protocol and database tests do not replace acceptance testing in the client that will receive notifications.

Clients can revoke an access or refresh token at `/token/revocation`, authenticating as the original application client. Either operation invalidates that grant and deletes its saved credential. Other users' grants remain independent. Removing an app or local connector does **not** guarantee that the client sends revocation. To immediately disable all use of a Galaxy API key, revoke that key in Galaxy.

The self-service flow starts with the MCP tool `get_connection_management_link`. The resource server sends the current opaque access token to the broker's authenticated `POST /management/ticket` endpoint and receives a random one-use link valid for five minutes. Only the dedicated resource client's HTTP Basic credential can create a ticket. The browser confirms that ticket and receives a server-rendered page for that access token's grant; no browser login cookie, separate hosted account, API key or persistent management bearer is used.

Every remove or disconnect form contains a different random action token, stored encrypted and valid once for ten minutes. The action token binds the current pseudonymous account, original grant and exact operation on the server, so the browser never submits an account or grant identifier. Management POSTs require the exact issuer origin and form content type. Ticket and action replay fails closed. API keys and internal identifiers are never rendered.

Removing a site is a monotonic reduction of the current plugin grant: issued tokens immediately introspect to the smaller set, while adding or replacing a site still requires a new authorization. Removing the final site or choosing Disconnect revokes that grant. Other grants remain isolated, including grants for the same Galaxy accounts in another client. None of these operations deletes Galaxy data or cancels jobs. Rotate a key by disconnecting the affected grant, rotating the key in Galaxy and reconnecting; rotating it in Galaxy immediately disables the old key.

Introspection at `/token/introspection` is restricted to the dedicated confidential resource client using `client_secret_basic`. It returns `galaxy_connections` for every grant, including one-site grants; each entry contains `instance`, `api_key` and the canonical `url`. Public clients, other confidential clients, refresh tokens and wrong audiences cannot obtain that credential-bearing response. Keys do not appear in OAuth token responses, user-facing errors or MCP results. Remapping any instance alias invalidates the whole connection set. Token revocation and refresh replay remove the whole grant; the authenticated management page can instead reduce a grant to fewer sites.

## Multi-instance tool routing

`get_galaxy_connections` lists only the requesting grant's authorized aliases and URLs, never credentials. Every other tool accepts an optional `instance` alias. Single-site calls may omit it; multi-site calls must specify it, and unknown aliases fail without contacting Galaxy. There is no shared active-site setting. Results include `galaxy: { instance, url }`, and cards retain that source for pagination, report loading and run refresh. A mismatched card response is rejected while the prior content is retained. Identifiers are site-local; this feature does not copy data or run a workflow across servers.

Deploy the updated resource server before updating the broker, and refresh client tool discovery afterward. The existing release command supports `--with-broker` for this ordered update, with per-container immutable rollback images. Existing grants do not acquire additional sites automatically. A resource server that cannot read `galaxy_connections` rejects these grants; it never redirects them to a default site. Keep provider-review snapshots distinct from an operator's newer deployment.

PostgreSQL stores encrypted model payloads and separately encrypted credentials using AES-256-GCM. Model lookup identifiers are keyed hashes; credential metadata is authenticated with its ciphertext. The broker process and authorized resource server necessarily handle plaintext keys in memory. Restrict their runtime access and database credentials, protect backups, and avoid logging HTTP headers, form bodies, tokens or introspection bodies. Encryption does not protect against a compromised running broker.

## Reproduce the integration checks

Run `pnpm test:broker`. By default, it starts an explicitly named disposable `postgres:17-alpine` container on an ephemeral loopback port and stops it afterward. No real Galaxy instance or key is used. Docker must be available; an unavailable dependency fails the test run rather than silently skipping it.

Alternatively, set `BROKER_TEST_DATABASE_URL` to a dedicated PostgreSQL database named `galaxy_broker_test` on loopback. The suite creates fixture tables and resets its rate-limit counters; never point it at production data. This explicit database mode does not require Docker.

The checks exercise real authorization-code/PKCE and refresh requests against the broker, its PostgreSQL adapter, and the existing MCP resource server. They cover two users/instances, the seven curated client profiles and issuer-bound callbacks, Claude CIMD with mocked public metadata, confidential-only introspection, consent/CSRF/Host checks, single-use concurrent redemption, refresh replay, provider restart, account switching, `form_post`, session loss, expiry, revocation, rate limiting, URL remapping and encrypted-record tampering. Account switching and `form_post` use an HTTP cookie-jar harness that follows the library's forms; they are not automated visual browser tests. These checks are local integration evidence, not proof that a particular provider's hosted OAuth connection or an AWS deployment has completed validation.

The implementation follows the [provider interaction API](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md#user-flows), [adapter contract](https://github.com/panva/node-oidc-provider/blob/v9.12.2/example/my_adapter.js), and [introspection authorization policy](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md#featuresintrospection). Review these contracts and rerun the tests when upgrading the pinned OAuth library.
