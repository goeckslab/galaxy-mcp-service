import { request } from "node:http";
import { expect, it } from "vitest";

import { startTestService } from "../helpers/service.js";

function albRequest(baseUrl: string, path: string, method = "GET") {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(new URL(path, baseUrl), {
      method,
      headers: { host: "10.0.12.34:3000", "user-agent": "ELB-HealthChecker/2.0" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

it("serves only exact GET health paths to ALB target-IP Hosts while retaining MCP Host validation", async () => {
  const service = await startTestService();
  try {
    expect(await albRequest(service.baseUrl, "/healthz")).toEqual({ status: 200, body: '{"status":"ok"}' });
    expect(await albRequest(service.baseUrl, "/readyz")).toEqual({ status: 200, body: '{"status":"ready"}' });
    for (const [path, method] of [
      ["/mcp", "GET"], ["/readyz/", "GET"], ["/healthz/extra", "GET"], ["/readyz", "POST"], ["/healthz", "HEAD"],
    ] as const) {
      expect(await albRequest(service.baseUrl, path, method)).toMatchObject({ status: 403 });
    }
  } finally {
    await service.stop();
  }
});
