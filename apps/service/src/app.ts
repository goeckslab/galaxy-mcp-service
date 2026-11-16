import express, { type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { isJSONRPCRequest } from "@modelcontextprotocol/server";

import {
  extractRequestMetadata,
  metadataLog,
  requestId,
  requireModernProtocolHeader,
} from "@galaxy-mcp-service/protocol";

import type { UniversalAuth } from "./auth.js";
import { createGalaxyMcpHandler, type GalaxyConnection } from "./mcp.js";
import { publicPage, publicPageCsp, publicPagePaths } from "./public-pages.js";
import { startRunEvents } from "./events.js";
import { galaxyIconPng } from "./brand-icon.js";

export interface AppOptions {
  auth?: UniversalAuth;
  galaxy?: GalaxyConnection;
  host?: string;
  log?: (line: string) => void;
  publicBaseUrl?: string;
}

function allowedHostnames(publicBaseUrl?: string): string[] {
  const hostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (publicBaseUrl === undefined || publicBaseUrl.trim() === "") return [...hostnames];

  const url = new URL(publicBaseUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment");
  }
  hostnames.add(url.hostname);
  return [...hostnames];
}

function requestHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
  }
  return headers;
}

export function createApp(options: AppOptions = {}) {
  if (options.auth !== undefined && options.galaxy !== undefined) {
    throw new Error("Universal OAuth mode cannot use a shared Galaxy connection");
  }
  const log = options.log ?? console.log;
  const allowedHosts = allowedHostnames(options.publicBaseUrl);
  const publicOrigin = options.publicBaseUrl?.trim() ? new URL(options.publicBaseUrl) : undefined;
  const stopEvents = options.auth?.eventRequest ? startRunEvents(options.auth.eventRequest,
    () => metadataLog({ timestamp: new Date().toISOString(), event: "run_events_unavailable" }, log)) : undefined;
  const mcpHandler = createGalaxyMcpHandler(
    (error) =>
      metadataLog(
        {
          timestamp: new Date().toISOString(),
          event: "mcp_error",
          error_name: error.name,
          jsonrpc_error_code: "code" in error ? (error as { code?: unknown }).code : undefined,
        },
        log,
      ),
    options.galaxy,
    publicOrigin?.protocol === "https:" ? publicOrigin.origin : undefined,
    options.auth?.createManagementLink,
    options.auth?.eventRequest,
    options.auth && new URL(options.auth.oauthMetadata.issuer).origin,
  );
  const nodeHandler = toNodeHandler({
    async fetch(request, handlerOptions) {
      const response = await mcpHandler.fetch(request, handlerOptions);
      if (response.status >= 400 && response.headers.get("content-type")?.includes("application/json")) {
        try {
          const payload: unknown = await response.clone().json();
          const error = payload !== null && typeof payload === "object" && "error" in payload ? payload.error : undefined;
          const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
          if (typeof code === "number") {
            metadataLog(
              {
                timestamp: new Date().toISOString(),
                event: "mcp_response_error",
                request_id: requestId(request.headers.get("x-request-id")),
                http_status: response.status,
                jsonrpc_error_code: code,
              },
              log,
            );
          }
        } catch {
          // A non-JSON error body is still recorded by request_complete.
        }
      }
      return response;
    },
  }, {
    onerror: (error) => metadataLog({ timestamp: new Date().toISOString(), event: "adapter_error", error_name: error.name }, log),
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // ALB uses the target's private IP as Host. Only fixed GET health responses bypass validation.
    if (req.method === "GET" && (req.path === "/healthz" || req.path === "/readyz")) {
      res.status(200).json({ status: req.path === "/healthz" ? "ok" : "ready" });
      return;
    }
    next();
  });
  app.use(createMcpExpressApp({
    host: options.host ?? "127.0.0.1",
    allowedHosts,
    jsonLimit: "256kb",
  }).disable("x-powered-by"));

  app.get(["/favicon.ico", "/favicon.png"], (_req, res) => {
    res.set({ "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }).type("png").send(galaxyIconPng);
  });

  app.get(publicPagePaths, (req, res) => {
    const page = publicPage(req.path);
    if (page === undefined) return res.sendStatus(404);
    res.set({
      "Content-Security-Policy": publicPageCsp,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=300",
    }).type("html").send(page);
  });

  if (options.auth !== undefined) {
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata: options.auth.oauthMetadata,
        resourceServerUrl: options.auth.resourceServerUrl,
        scopesSupported: options.auth.scopes,
        resourceName: "Galaxy",
      }),
    );
  }

  app.use((req, res, next) => {
    const id = requestId(req.header("x-request-id"));
    req.headers["x-request-id"] = id;
    res.setHeader("x-request-id", id);
    res.on("finish", () => {
      const body = req.path === "/mcp" ? req.body : undefined;
      metadataLog(
        {
          event: "request_complete",
          ...extractRequestMetadata(body, requestHeaders(req), req.method, id),
          http_status: res.statusCode,
          ...(res.locals.jsonrpc_error_code !== undefined && { jsonrpc_error_code: res.locals.jsonrpc_error_code }),
        },
        log,
      );
    });
    next();
  });

  const mcpRoute: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && isJSONRPCRequest(req.body)) {
      const mismatch = requireModernProtocolHeader(req.body, req.header("mcp-protocol-version"));
      if (mismatch !== undefined) {
        res.locals.jsonrpc_error_code = mismatch.code;
        const id = req.body !== null && typeof req.body === "object" && "id" in req.body ? req.body.id : null;
        res.status(400).json({ jsonrpc: "2.0", id, error: mismatch });
        return;
      }
    }
    void nodeHandler(req, res, req.body).catch(next);
  };
  if (options.auth === undefined) {
    app.all("/mcp", mcpRoute);
  } else {
    app.all(
      "/mcp",
      requireBearerAuth({
        verifier: options.auth.verifier,
        requiredScopes: options.auth.scopes,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.auth.resourceServerUrl),
      }),
      mcpRoute,
    );
  }

  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const parseError = error instanceof SyntaxError && "body" in error;
    const tooLarge = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large";
    const code = parseError ? -32700 : -32600;
    res.locals.jsonrpc_error_code = code;
    metadataLog(
      {
        timestamp: new Date().toISOString(),
        event: "request_error",
        request_id: requestId(req.header("x-request-id")),
        error_name: error instanceof Error ? error.name : "Error",
        jsonrpc_error_code: code,
      },
      log,
    );
    res.status(tooLarge ? 413 : 400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code, message: parseError ? "Parse error" : tooLarge ? "Request body too large" : "Invalid request" },
    });
  };
  app.use(errors);

  return {
    app,
    mcpHandler,
    async close(): Promise<void> {
      await stopEvents?.();
      await mcpHandler.close();
    },
  };
}
