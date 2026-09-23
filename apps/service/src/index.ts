import { createApp } from "./app.js";
import { loadUniversalAuth } from "./auth.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535");
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
const galaxyUrl = process.env.GALAXY_URL?.trim() || undefined;
const galaxyApiKey = process.env.GALAXY_API_KEY?.trim() || undefined;
const universalValues = {
  metadataUrl: process.env.OAUTH_METADATA_URL?.trim() || undefined,
  introspectionClientId: process.env.OAUTH_INTROSPECTION_CLIENT_ID?.trim() || undefined,
  introspectionClientSecret: process.env.OAUTH_INTROSPECTION_CLIENT_SECRET?.trim() || undefined,
  instancesJson: process.env.GALAXY_INSTANCES_JSON?.trim() || undefined,
};
if ((galaxyUrl === undefined) !== (galaxyApiKey === undefined)) {
  throw new Error("GALAXY_URL and GALAXY_API_KEY must be set together");
}
if (galaxyUrl !== undefined) {
  const parsed = new URL(galaxyUrl);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("GALAXY_URL must be an HTTP(S) URL without credentials, query, or fragment");
  }
}
const universalCount = Object.values(universalValues).filter((value) => value !== undefined).length;
if (universalCount !== 0 && universalCount !== Object.keys(universalValues).length) {
  throw new Error(
    "OAUTH_METADATA_URL, OAUTH_INTROSPECTION_CLIENT_ID, OAUTH_INTROSPECTION_CLIENT_SECRET, and GALAXY_INSTANCES_JSON must be set together",
  );
}
if (universalCount > 0 && (galaxyUrl !== undefined || galaxyApiKey !== undefined)) {
  throw new Error("Universal OAuth mode cannot use the shared GALAXY_URL/GALAXY_API_KEY connection");
}
if (universalCount > 0 && publicBaseUrl === undefined) {
  throw new Error("PUBLIC_BASE_URL is required in Universal OAuth mode");
}

const auth =
  universalCount > 0
    ? await loadUniversalAuth({
        metadataUrl: universalValues.metadataUrl!,
        introspectionClientId: universalValues.introspectionClientId!,
        introspectionClientSecret: universalValues.introspectionClientSecret!,
        instancesJson: universalValues.instancesJson!,
        resourceServerUrl: new URL("/mcp", `${publicBaseUrl!}/`).href,
      })
    : undefined;

const service = createApp({
  host,
  ...(auth && { auth }),
  ...(galaxyUrl && galaxyApiKey && { galaxy: { baseUrl: galaxyUrl, apiKey: galaxyApiKey } }),
  ...(publicBaseUrl && { publicBaseUrl }),
});

const httpServer = service.app.listen(port, host, () => {
  console.log(JSON.stringify({ event: "service_started", host, port }));
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "service_stopping", signal }));
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  await service.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
