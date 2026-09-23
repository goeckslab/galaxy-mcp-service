import { createServer } from "node:http";

import { createBroker } from "./broker.js";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("Required broker configuration is missing.");
  return value;
}

try {
  const key = required("BROKER_ENCRYPTION_KEY");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error("Invalid broker encryption key.");
  const broker = await createBroker({
    issuer: required("BROKER_ISSUER"),
    resource: required("BROKER_RESOURCE"),
    databaseUrl: required("BROKER_DATABASE_URL"),
    encryptionKey: Buffer.from(key, "base64"),
    cookieKeys: JSON.parse(required("BROKER_COOKIE_KEYS_JSON")),
    jwks: JSON.parse(required("BROKER_JWKS_JSON")),
    clients: JSON.parse(required("BROKER_CLIENTS_JSON")),
    resourceClientId: required("BROKER_RESOURCE_CLIENT_ID"),
    resourceClientSecret: required("BROKER_RESOURCE_CLIENT_SECRET"),
    instances: JSON.parse(required("GALAXY_INSTANCES_JSON")),
    allowLoopback: process.env.BROKER_ALLOW_LOOPBACK === "1",
    trustProxy: process.env.BROKER_TRUST_PROXY === "1",
  });
  const server = createServer(broker.callback);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 8081), process.env.HOST || "127.0.0.1", () => {
    console.log("Galaxy credential broker is listening.");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => { void broker.close().then(() => process.exit(0)); });
      server.closeIdleConnections();
    });
  }
} catch {
  console.error("Broker startup failed. Check required configuration and database connectivity.");
  process.exitCode = 1;
}
