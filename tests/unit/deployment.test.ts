import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = JSON.parse(readFileSync(new URL("../../deploy/ecs-express.json", import.meta.url), "utf8"));
const service = template.Resources.GalaxyService.Properties;
const container = service.PrimaryContainer;
const lightsail = JSON.parse(readFileSync(new URL("../../deploy/lightsail.compose.json", import.meta.url), "utf8"));

describe("AWS deployment boundary", () => {
  it("keeps the Lightsail database and app ports private with mandatory Universal OAuth inputs", () => {
    const { proxy, mcp, broker, postgres, "legacy-mcp": legacyMcp, "legacy-broker": legacyBroker } = lightsail.services;
    expect(Object.keys(lightsail.services)).toEqual(["proxy", "mcp", "broker", "legacy-mcp", "legacy-broker", "postgres"]);
    expect(proxy.ports).toEqual(["80:80", "443:443"]);
    for (const backend of [mcp, broker, legacyMcp, legacyBroker, postgres]) expect(backend).not.toHaveProperty("ports");
    expect(lightsail.networks.database.internal).toBe(true);
    expect(postgres.networks).toEqual(["database"]);
    expect(broker.networks).toEqual(["app", "database"]);
    expect(mcp.networks).toEqual(["app"]);
    expect(proxy.networks.app.aliases).toEqual(["${MCP_HOST:?Set the owned MCP hostname}", "${LEGACY_BROKER_HOST:?Set the original broker hostname}"]);
    expect(proxy).not.toHaveProperty("depends_on");
    expect(broker.depends_on.postgres.condition).toBe("service_healthy");
    expect(mcp.depends_on.broker.condition).toBe("service_healthy");
    for (const backend of [mcp, broker]) {
      expect(backend.image).toContain("${GALAXY_MCP_IMAGE:?");
      expect(backend.pull_policy).toBe("never");
      expect(backend.read_only).toBe(true);
      expect(backend.cap_drop).toEqual(["ALL"]);
      expect(backend.environment).not.toHaveProperty("GALAXY_API_KEY");
      expect(backend.environment).not.toHaveProperty("BROKER_ALLOW_LOOPBACK");
      expect(backend.environment.GALAXY_INSTANCES_JSON).toContain(":?");
    }
    expect(mcp.environment.OAUTH_INTROSPECTION_CLIENT_SECRET).toBe(broker.environment.BROKER_RESOURCE_CLIENT_SECRET);
    expect(mcp.environment.OAUTH_INTROSPECTION_CLIENT_ID).toBe(broker.environment.BROKER_RESOURCE_CLIENT_ID);
    expect(broker.environment.BROKER_RESOURCE).toBe(`${mcp.environment.PUBLIC_BASE_URL}/mcp`);
    expect(mcp.environment.OAUTH_METADATA_URL).toBe(`${broker.environment.BROKER_ISSUER}/.well-known/oauth-authorization-server`);
    expect(broker.environment.BROKER_ISSUER).toBe(mcp.environment.PUBLIC_BASE_URL);
    // The original hostnames reuse the same image, secrets and database through extends.
    expect(legacyMcp.extends).toEqual({ service: "mcp" });
    expect(legacyBroker.extends).toEqual({ service: "broker" });
    expect(Object.keys(legacyMcp.environment).sort()).toEqual(["OAUTH_METADATA_URL", "PUBLIC_BASE_URL"]);
    expect(Object.keys(legacyBroker.environment).sort()).toEqual(["BROKER_ISSUER", "BROKER_RESOURCE"]);
    expect(legacyBroker.environment.BROKER_RESOURCE).toBe(`${legacyMcp.environment.PUBLIC_BASE_URL}/mcp`);
    expect(legacyMcp.environment.OAUTH_METADATA_URL).toBe(`${legacyBroker.environment.BROKER_ISSUER}/.well-known/oauth-authorization-server`);
    expect(legacyMcp.depends_on["legacy-broker"].condition).toBe("service_healthy");
    for (const key of ["BROKER_ENCRYPTION_KEY", "BROKER_JWKS_JSON", "BROKER_COOKIE_KEYS_JSON", "BROKER_CLIENTS_JSON"])
      expect(broker.environment[key]).toContain(":?");
    for (const sidecar of [proxy, postgres]) expect(sidecar.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(postgres.volumes).toEqual(["postgres-data:/var/lib/postgresql/data"]);
    const proxyConfig = readFileSync(new URL("../../deploy/Caddyfile", import.meta.url), "utf8");
    expect(proxyConfig).toContain("admin off");
    expect(proxyConfig).toContain("exclude http.log.error");
    expect(proxyConfig).toContain("cert_issuer acme");
    expect(proxyConfig).toContain("dir https://acme-v02.api.letsencrypt.org/directory");
    expect(proxyConfig).not.toContain("tls_insecure_skip_verify");
    const shared = /\{\$MCP_HOST\} \{\n\t@broker path ([^\n]+)/.exec(proxyConfig)![1]!.split(" ");
    for (const path of ["/.well-known/oauth-authorization-server", "/auth", "/token", "/jwks", "/interaction/*", "/connections/*", "/management/*", "/events/*"])
      expect(shared).toContain(path);
    for (const path of ["/", "/mcp", "/readyz", "/support"]) expect(shared).not.toContain(path);
    expect(proxyConfig).not.toContain("openai-apps-challenge");
    expect(proxyConfig).not.toContain("/review/");
  });

  it("requires explicit production inputs and injects only the introspection secret", () => {
    expect(Object.keys(template.Resources)).toEqual(["GalaxyService"]);
    expect(template.Resources.GalaxyService.Type).toBe("AWS::ECS::ExpressGatewayService");
    for (const parameter of Object.values(template.Parameters)) expect(parameter).not.toHaveProperty("Default");

    expect(Object.fromEntries(container.Environment.map((entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value]))).toEqual({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8080",
      PUBLIC_BASE_URL: { Ref: "PublicBaseUrl" },
      OAUTH_METADATA_URL: { Ref: "OAuthMetadataUrl" },
      OAUTH_INTROSPECTION_CLIENT_ID: { Ref: "IntrospectionClientId" },
      GALAXY_INSTANCES_JSON: { Ref: "GalaxyInstancesJson" },
    });
    expect(container.Secrets).toEqual([{
      Name: "OAUTH_INTROSPECTION_CLIENT_SECRET",
      ValueFrom: { Ref: "IntrospectionSecretArn" },
    }]);
    expect(service.NetworkConfiguration).toEqual({ Subnets: [{ Ref: "PublicSubnetA" }, { Ref: "PublicSubnetB" }] });
    expect(template.Rules.DistinctSubnets.Assertions[0].Assert).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "PublicSubnetA" }, { Ref: "PublicSubnetB" }] }],
    });
    expect(service).toMatchObject({ Cpu: "256", Memory: "512", HealthCheckPath: "/readyz" });
    expect(container.ContainerPort).toBe(8080);
    expect(service.ScalingTarget).toEqual({ AutoScalingMetric: "AVERAGE_CPU", AutoScalingTargetValue: 60, MinTaskCount: 1, MaxTaskCount: 2 });
    expect(template.Outputs.PublicMcpUrl.Value).toEqual({ "Fn::Sub": "${PublicBaseUrl}/mcp" });
  });

  it.each([
    ["ImageUri", `123456789012.dkr.ecr.us-east-1.amazonaws.com/galaxy-mcp@sha256:${"a".repeat(64)}`, ["galaxy-mcp:latest", "galaxy-mcp@sha256:abc"]],
    ["PublicBaseUrl", "https://mcp.example.org", ["", "http://mcp.example.org", "https://mcp.example.org/", "https://mcp.example.org/mcp", "https://user:secret@mcp.example.org", "https://127.0.0.1"]],
    ["OAuthMetadataUrl", "https://auth.example.org/.well-known/oauth-authorization-server", ["", "http://auth.example.org/metadata", "https://auth.example.org/metadata?secret=bad", "https://user:secret@auth.example.org/metadata"]],
    ["IntrospectionClientId", "galaxy-mcp-resource-server", ["", " "]],
    ["IntrospectionSecretArn", "arn:aws:secretsmanager:us-east-1:123456789012:secret:galaxy/introspection-aBcDeF", ["", "raw-client-secret", "arn:aws:secretsmanager:us-east-1:123456789012:secret:"]],
  ])("constrains %s without embedding a working endpoint or secret", (name, valid, invalid) => {
    const pattern = new RegExp(`^(?:${template.Parameters[name].AllowedPattern})$`);
    expect(valid).toMatch(pattern);
    for (const value of invalid) expect(value).not.toMatch(pattern);
  });
});
