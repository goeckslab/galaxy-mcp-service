# AWS deployment

For operators deploying or updating the service on AWS. End users install the [Galaxy plugin](https://github.com/goeckslab/galaxy-plugin) instead. Choose one hosting topology below; for an existing Lightsail installation, go directly to [Routine MCP updates](#routine-mcp-updates). Configure persistent secrets and OAuth clients using the [broker guide](broker.md).

## Low-cost single-server option

[Lightsail Compose](../deploy/lightsail.compose.json) cohosts the existing MCP service, OAuth broker, PostgreSQL and Caddy on one Linux server. It creates no AWS resources by itself. This is the low-cost starting topology; the ECS template below is an alternative, not another required service. A 2 GB machine needs real capacity checks before release and is not highly available.

Only Caddy publishes ports 80/443. MCP and broker ports are unpublished; PostgreSQL is on an internal Docker network shared only with the broker. The database connection stays on that one host's private bridge, without TLS; a remote database requires verified TLS. Applications retain the image's non-root user and readiness checks, read-only root filesystems, and per-container memory/log limits. Named volumes preserve the database and certificate state across container replacements; **volumes are not backups**.

Before starting, approve the server/network costs, attach a stable address, and point one owned hostname at it. Allow public TCP 80/443 only after approving public exposure; keep SSH restricted and never open ports 5432, 8080 or Caddy's administration port. Caddy obtains and renews [public HTTPS certificates](https://caddyserver.com/docs/automatic-https) using only Let's Encrypt; obtain approval of the applicable [subscriber agreement](https://letsencrypt.org/repository/) before starting certificate issuance. Certificate Transparency publishes the certified hostnames, not application data. Publish AAAA records only when IPv6 routing and firewall rules are verified.

Create an owner-only `data/lightsail.env` using the deployment's secret-custody process; `data/` is excluded from Git and Docker builds. Set these variables without printing their values:

- `MCP_HOST`: the DNS hostname, without a scheme or path, such as `mcp.example.org`. The MCP service and the broker share it: Caddy sends the OAuth and connection-management paths to the broker and everything else to MCP, and the broker's issuer is `https://MCP_HOST`.
- `LEGACY_MCP_HOST` and `LEGACY_BROKER_HOST`: the original two hostnames of the hosted deployment. The `legacy-mcp` and `legacy-broker` containers keep serving them, with the same image, secrets and database, so existing connections keep working. Remove both services, their Caddy blocks and these variables once users have moved.
- `GALAXY_MCP_IMAGE`: a unique local release tag built from the repository's Dockerfile on the target architecture, or an already-loaded digest-pinned image. Both application containers use that exact image; Compose will not pull a replacement.
- `POSTGRES_PASSWORD`: a persistent cryptographically random password of at least 32 characters using only URL-safe letters, digits, `_` and `-` because it is also part of the broker database URL.
- `BROKER_ENCRYPTION_KEY`, `BROKER_COOKIE_KEYS_JSON`, `BROKER_JWKS_JSON`, `BROKER_RESOURCE_CLIENT_SECRET`, `BROKER_CLIENTS_JSON` and `GALAXY_INSTANCES_JSON`: the persistent secrets, actual provider registrations and approved instance map described in the [broker guide](broker.md). Single-quote JSON values in the env file. There is no shared Galaxy key and no example callback registered automatically.

From the repository root, after these inputs and approvals are in place:

```sh
docker build -t galaxy-mcp-service:release-YYYYMMDD .
docker compose --env-file data/lightsail.env -f deploy/lightsail.compose.json config --quiet
docker compose --env-file data/lightsail.env -f deploy/lightsail.compose.json run --rm --no-deps proxy caddy validate --config /etc/caddy/Caddyfile
docker compose --env-file data/lightsail.env -f deploy/lightsail.compose.json up -d --wait --wait-timeout 180
```

Replace the example tag and use the same tag in `GALAXY_MCP_IMAGE`. Never run plain `compose config`, dump container environment, or capture secret files in logs/screenshots. Restrict access to the host and Docker daemon, which can read container configuration. Back up the database and persistent broker keys separately into approved encrypted custody and verify a restore before public onboarding. Do not use `down --volumes` on production. For a PostgreSQL major upgrade, follow its migration procedure rather than changing the image tag in place.

The proxy has no backend startup dependency, PostgreSQL must become healthy before the broker starts, and MCP waits for the broker. MCP discovery uses the real broker HTTPS hostname, resolved to Caddy inside the Docker network, without disabling certificate verification. The initial MCP start can retry while Caddy obtains its certificate. Repeated failures need investigation; do not replace OAuth with a shared key to get a green health check. Caddy preserves Host, rejects spoofed forwarded headers by default, and streams SSE without response buffering. Its request-error log is excluded to avoid recording OAuth callback query strings; process/TLS logs and metadata-only application logs remain available. Do not enable raw request/debug logging.

The checked-in Caddyfile is a generic deployment configuration. Directory ownership challenges and reviewer-only media routes are deployment-specific: add them to the operator's live Caddyfile only when needed, and keep that configuration out of the public repository. Routine MCP releases do not replace or reload the proxy. Before changing the live Caddyfile, verify that any active review links and ownership challenge will remain reachable.

After startup, verify valid public TLS, unauthenticated MCP rejection, actual provider callbacks, two-user/two-instance isolation, token revocation and a restart. Passing local configuration checks or creating a domain does not establish a running or release-ready service.

### Routine MCP updates

After transferring the reviewed source to the existing server, run one command from the repository root as the owner of the 0600 deployment environment:

```sh
sudo python3 -B deploy/release.py galaxy-mcp-service:release-YYYYMMDD-UNIQUE
```

Choose a new tag each time. When the legacy hostnames are set, every step below also covers `legacy-mcp` and `legacy-broker`. The script refuses reused image tags and concurrent releases, requires healthy current containers, and builds the candidate with the existing lint, type and service tests. Only after those pass does it save a protected configuration backup and replace MCP. It waits for container readiness, checks public HTTPS readiness and anonymous MCP rejection, and restores the previous configuration and immutable image on activation or post-deployment check failure. By default the broker is unchanged. For a reviewed compatible broker update, add `--with-broker`: MCP updates first, followed by the broker and its public discovery check, then MCP is recreated to discover the updated broker capabilities. Failure rolls back the broker before MCP, each to its own previous immutable image. Backups and images remain available; neither mode removes database volumes, updates the proxy, provisions AWS resources or prints the environment. An unsuccessful rollback is reported as a failure, not as a successful release. Host loss or a forced kill still requires operator recovery; configuration backups do not replace encrypted database backups.

If the deployment checkout contains an operator-customized `deploy/Caddyfile`, pass `--build-context path/to/clean-source` with a reviewed source directory containing the repository's generic template. This keeps operator-specific routes out of the build and its template tests. The script still uses the existing checkout's private environment and Compose configuration; it does not replace or reload the live proxy.

To add reviewed sites, update the curated JSON map and release both components together:

```sh
sudo python3 -B deploy/release.py galaxy-mcp-service:release-YYYYMMDD-UNIQUE --with-broker --instances deploy/galaxy-instances.json
```

This option permits additions only: every existing alias and canonical URL must remain unchanged. The protected configuration backup covers the site map as well as the image, and failure restores both. Existing grants do not gain access to newly configured sites; users must authorize their own account on each selected site. Directory listings and GitHub site requests never modify the map automatically.

This is server-side release automation, not connected GitHub-to-AWS delivery. Source transfer still uses the existing approved access path. The script requires the existing Linux host's Python 3, Docker Compose and curl; it does not create SSH keys, open a firewall, or install a CI agent. Its mocked failure/safety tests do not establish a real production rollback drill.

Use it only for compatible MCP updates. Keep the published UI resource URI unchanged for compatible styling/content changes. New tool metadata, schemas, permissions, UI URIs or CSP require the separate [OpenAI review/update flow](https://developers.openai.com/plugins/deploy/app-review#how-published-mcp-metadata-versions-work). Initial setup, broker/database migrations and changes to the Compose topology remain separate operations. The current Compose file shares one image setting between MCP and broker: do not follow an MCP-only release with a full-stack `up` unless a broker update is also intended and reviewed.

## ECS Express alternative

[The CloudFormation template](../deploy/ecs-express.json) runs the Galaxy MCP **resource server**, including its UI resources, on ECS Express Mode. It does not provide an OAuth broker, purchase a domain, configure DNS, or deploy anything automatically. Local validation is not evidence of a running AWS deployment.

The template uses the native [ExpressGatewayService resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecs-expressgatewayservice.html), with a digest-pinned image, `/readyz` health checks, and required Universal OAuth configuration. Its initial capacity is 0.25 vCPU / 512 MiB per task, scaling from one to two tasks. This is a small starting configuration, not a high-availability guarantee or a spending cap; deployment overlap and the load balancer, logs, secrets, public IPs, and data transfer can add costs.

## Before creating a stack

Supply these inputs to CloudFormation; none has a default:

- `ServiceName` and `ImageUri`: an approved service name and an ECR image digest. Build the repository's Dockerfile for `linux/amd64`; Express Mode's native task architecture is x86_64.
- `ExecutionRoleArn` and `InfrastructureRoleArn`: existing roles with the [AWS-documented trust and permissions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-getting-started.html). The execution role additionally needs narrowly scoped secret access and, for a customer-managed encryption key, `kms:Decrypt`. The application itself does not need an AWS task role.
- `PublicSubnetA` and `PublicSubnetB`: two public subnets in the same VPC, different availability zones, with Internet Gateway routes and at least eight free IPs each. Verify these in the selected account and Region; the template only checks that the IDs differ. Existing Express services in that VPC can constrain the available zones. Private subnets produce an **internal** load balancer. No additional security group is supplied, so Express creates its minimal ingress rules. See [Express networking and runtime defaults](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html).
- `PublicBaseUrl`: the owned HTTPS origin clients will use, with no trailing slash or `/mcp`. Arrange an ACM certificate in the load balancer's Region and DNS control for that hostname.
- `OAuthMetadataUrl`, `IntrospectionClientId`, and `IntrospectionSecretArn`: an already-operational broker, a dedicated confidential introspection client, and the ARN of its secret in Secrets Manager in the deployment Region. The entire nonempty `SecretString` must contain the client secret, **not a JSON object**. Do not paste credentials into template parameters, files, or logs. Secret rotation requires new tasks; existing containers do not reload injected values. See [ECS secret injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html).
- `GalaxyInstancesJson`: a nonempty JSON map of approved instance names to HTTPS Galaxy URLs. No Galaxy API keys belong here; the broker supplies each user's instance-bound credentials through authenticated introspection.

The broker must satisfy the [OAuth client and introspection contract](broker.md#register-an-ai-client), including exact resource audience and user/site isolation. The service validates discovery and configuration before listening; `/readyz` is not an ongoing broker or Galaxy availability probe.

## Validate, then deploy deliberately

From the repository root, these checks do not call AWS:

```sh
pnpm exec vitest run tests/unit/deployment.test.ts
cfn-lint deploy/ecs-express.json
```

Use a current [cfn-lint release](https://github.com/aws-cloudformation/cfn-lint) that recognizes `AWS::ECS::ExpressGatewayService`. After account, Region, IAM, image, networking, broker, and cost review, upload the template in CloudFormation and create a change set. Review its inputs and resource impact before executing it. This template uses the default ECS cluster; Express Mode manages the accompanying load balancer, logs, security groups, and scaling resources.

## Connect the public hostname

A successful stack alone does **not** make the custom hostname usable. Follow [AWS's custom-domain procedure](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-advanced-customization.html):

1. In the existing Express-managed listener rule, add the custom hostname as another **OR value** of the host-header condition. Preserve the AWS-assigned hostname and existing forward actions; do not create a separate rule pinned to a transient target group.
2. Attach the hostname's ACM certificate to the HTTPS listener.
3. Point a Route 53 alias at the load balancer, or use a CNAME from an external DNS provider for a subdomain.

The stack outputs identify the listener and rule. These customizations are outside this template: record them operationally and recheck them after service updates. Do not loosen the application's Host validation to work around missing routing. With a custom `PublicBaseUrl`, the AWS-assigned endpoint can answer health checks but `/mcp` rejects that different hostname.

Before release, verify HTTPS and `/readyz` through the **custom hostname**; unauthenticated `/mcp` must return 401 with OAuth discovery. Then test authorization, read-only Galaxy access for two users and two instances, revoked tokens, task restart, and credential rotation. Recheck the public hostname after an image update. Inspect metadata-only service logs without printing request tokens, environment variables, or introspection bodies.

## Deploy the broker separately

The repository includes a [credential-linking broker](broker.md), implemented with `oidc-provider` and PostgreSQL. The ECS template above deploys only the MCP resource server; it does not provision the broker, its database, client registrations, or persistent encryption/signing secrets. The same container image can run the broker with a command override. Follow the broker guide for configuration, key custody, trusted-proxy requirements, and local validation.

The broker currently supports pre-registered OAuth clients. Before public release, deploy it behind its own HTTPS origin, provision a private durable PostgreSQL database with encrypted backups and verified TLS, register the exact client callbacks, and complete real two-account/two-instance authorization tests. Keep its Galaxy instance map aligned with the resource server's map. Account/domain choices do not block local development, but operating this infrastructure and supplying the inputs above block public release.

Cognito alone is not a drop-in replacement: its [documented endpoints](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html) do not provide this RFC 7662 credential-bearing introspection contract. Galaxy keys must remain outside general token claims; only the authenticated confidential MCP resource-server client may receive them. The included broker enforces this boundary separately from the library's general [introspection policy](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md#featuresintrospection).
