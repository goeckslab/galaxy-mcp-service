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

Dynamic client registration and Client ID Metadata Documents are not enabled. Each AI provider or native client needs an explicit registration in `BROKER_CLIENTS_JSON`, and a way to use that client ID. Clients supporting only automatic dynamic registration are not ready to connect to this broker without additional adapter support.

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

Point the client at the broker's discovery document, `/.well-known/oauth-authorization-server`. Authorization and token endpoints are `/auth` and `/token`. Configure the existing MCP service with:

- `OAUTH_METADATA_URL`: the broker origin plus `/.well-known/oauth-authorization-server`.
- `OAUTH_INTROSPECTION_CLIENT_ID` and `OAUTH_INTROSPECTION_CLIENT_SECRET`: the dedicated resource-client credentials.
- `PUBLIC_BASE_URL`: the public MCP origin; its `/mcp` URL must equal `BROKER_RESOURCE`.
- `GALAXY_INSTANCES_JSON`: the same canonical allowlist used by the broker.

The metadata must advertise authorization code, PKCE `S256`, `galaxy:full` and an introspection endpoint supporting `client_secret_basic`. Active introspection responses must contain `sub`, `client_id`, `scope`, `exp`, `iss` and `aud`; the audience must exactly match the MCP resource URL. Credential fields depend on whether the grant contains one site or multiple sites, as specified below. The resource server checks these fields before calling Galaxy. Workspace email/domain restrictions require additional verified-email identity support; the broker's pseudonymous `openid` subject is not an email address.

## Curated Galaxy sites

The hosted common-site list is maintained in [deploy/galaxy-instances.json](../deploy/galaxy-instances.json): US (`main`), Europe (`eu`), Australia (`au`), France (`fr`) and Canada (`ca`). These five public servers appear in the [Galaxy account guide](https://training.galaxyproject.org/training-material/faqs/galaxy/account_create.html). The directory is a discovery source, not an automatically trusted registry.

The authorization page labels `https://usegalaxy.org` as **US**. Its internal `main` alias remains unchanged for form submissions, saved grants and MCP calls; this display label does not require reconnecting existing accounts.

Users can [request another site through GitHub Issues](https://mcp.galaxymcp.org/support#request-site). Requests are public and should include the canonical HTTPS URL, institution, public operator contact and intended non-sensitive research use, never credentials or private data. Posting a request does not create a connection or enable a site automatically. The publisher reviews the public endpoint and API compatibility before enabling it. Private-network endpoints are outside this hosted list. Account-specific privacy and deletion requests use the separate [private contact form](https://mcp.galaxymcp.org/support#private-contact), not public Issues.

Both MCP and broker must use the same approved map. The [release command](aws-deployment.md#routine-mcp-updates) supports reviewed additions with configuration rollback; existing aliases cannot be removed or remapped through that command. Adding a site does not expand saved grants. Users authorize their own account separately for each newly selected site.

## Connection lifetime and revocation

Every authorization requires the broker's own explicit consent form. Enter a key only for each intended server; blank fields grant no access. Up to ten sites can be authorized together, with one account per site. All selected keys are verified through bounded, read-only current-user requests before any grant is saved. If any verification fails, no partial connection is created.

Identity is derived from canonical Galaxy URLs and their user IDs, so identical IDs on different servers remain separate identities. A new authorization creates an immutable grant-bound credential record containing the selected connection set. Reconnecting does not expand, retarget or revoke an older grant: revoke the old grant separately when replacing it. Single-site subjects, saved credentials and the old form submission format remain compatible. The encrypted payload carries the bundle without a database schema migration.

After consent or cancellation, the form response completes with a script-free page that automatically continues to the provider's validated same-origin resume URL, with a manual link as fallback. This separates form submission from the subsequent client callback: browsers can enforce `form-action 'self'` without blocking the OAuth redirect. The key is never included in the continuation page or URL, and client callbacks remain exactly registered and PKCE-protected.

The login form uses `Referrer-Policy: same-origin`: native browser form submissions retain the origin needed by the strict CSRF origin check, while cross-origin navigation sends no referrer. Continuation and other responses retain `no-referrer`. Null, absent and foreign form origins are rejected; do not relax this validation to fix browser login failures.

Access tokens last 10 minutes. Connections have a fixed maximum lifetime of 30 days; refresh tokens rotate on each use, and replay revokes their entire grant. Losing a browser session does not revoke an explicitly consented connection. Expired records are rejected immediately and pruned from the live database periodically; backup retention must be specified by the operator.

Clients can revoke an access or refresh token at `/token/revocation`, authenticating as the original application client. Either operation invalidates that grant and deletes its saved credential. Other users' grants remain independent. Removing an app or local connector does **not** guarantee that the client sends revocation. To immediately disable all use of a Galaxy API key, revoke that key in Galaxy. There is not yet a standalone browser page listing or revoking previous connections.

Introspection at `/token/introspection` is restricted to the dedicated confidential resource client using `client_secret_basic`. Single-site responses retain `galaxy_instance`, `galaxy_api_key` and `galaxy_url`. Bundles instead return `galaxy_connections`, each containing `instance`, `api_key` and the canonical `url`; they omit the legacy fields so older resource servers fail closed rather than selecting the first key. Public clients, other confidential clients, refresh tokens and wrong audiences cannot obtain that credential-bearing response. Keys do not appear in OAuth token responses, user-facing errors or MCP results. Remapping any instance alias invalidates the whole affected bundle. Revocation and refresh replay also remove the whole grant, not one member site.

## Multi-instance tool routing

`get_galaxy_connections` lists only the requesting grant's authorized aliases and URLs, never credentials. Every other tool accepts an optional `instance` alias. Single-site calls may omit it for compatibility; multi-site calls must specify it, and unknown aliases fail without contacting Galaxy. There is no shared active-site setting. Results include `galaxy: { instance, url }`, and cards retain that source for pagination, report loading and run refresh. A mismatched card response is rejected while the prior content is retained. Identifiers are site-local; this feature does not copy data or run a workflow across servers.

Deploy the updated resource server before enabling bundle authorization in the broker, and refresh client tool discovery afterward. The existing release command supports `--with-broker` for this ordered update, with per-container immutable rollback images. Existing grants do not acquire additional sites automatically. Rollback to an older resource server leaves bundles unusable until upgrade or single-site reauthorization; it never redirects them to a default site. Keep provider-review snapshots distinct from an operator's newer deployment.

PostgreSQL stores encrypted model payloads and separately encrypted credentials using AES-256-GCM. Model lookup identifiers are keyed hashes; credential metadata is authenticated with its ciphertext. The broker process and authorized resource server necessarily handle plaintext keys in memory. Restrict their runtime access and database credentials, protect backups, and avoid logging HTTP headers, form bodies, tokens or introspection bodies. Encryption does not protect against a compromised running broker.

## Reproduce the integration checks

Run `pnpm test:broker`. By default, it starts an explicitly named disposable `postgres:17-alpine` container on an ephemeral loopback port and stops it afterward. No real Galaxy instance or key is used. Docker must be available; an unavailable dependency fails the test run rather than silently skipping it.

Alternatively, set `BROKER_TEST_DATABASE_URL` to a dedicated PostgreSQL database named `galaxy_broker_test` on loopback. The suite creates fixture tables and resets its rate-limit counters; never point it at production data. This explicit database mode does not require Docker.

The checks exercise real authorization-code/PKCE and refresh requests against the broker, its PostgreSQL adapter, and the existing MCP resource server. They cover two users/instances, confidential-only introspection, consent/CSRF/Host checks, single-use concurrent redemption, refresh replay, provider restart, account switching, `form_post`, session loss, expiry, revocation, rate limiting, URL remapping and encrypted-record tampering. Account switching and `form_post` use an HTTP cookie-jar harness that follows the library's forms; they are not automated visual browser tests. These checks are local integration evidence, not proof that a particular provider's hosted OAuth connection or an AWS deployment has completed validation.

The implementation follows the [provider interaction API](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md#user-flows), [adapter contract](https://github.com/panva/node-oidc-provider/blob/v9.12.2/example/my_adapter.js), and [introspection authorization policy](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md#featuresintrospection). Review these contracts and rerun the tests when upgrading the pinned OAuth library.
