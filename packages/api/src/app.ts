// packages/api/src/app.ts
// Hono app factory. Mounts routes and Better Auth.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { env } from "./env";
import { adminAdministratorsRouter } from "./routes/admin-administrators";
import { adminAuditRouter } from "./routes/admin-audit";
import { adminErasureRouter } from "./routes/admin-erasure";
import { adminRouter } from "./routes/admin";
import { healthRouter } from "./routes/health";
import { publicRouter } from "./routes/public";
import { tenantRouter } from "./routes/tenant";

export function allowedCorsOrigin(origin: string | undefined): string | undefined {
  if (!origin) return env.PUBLIC_APP_URL;
  if (origin === env.PUBLIC_APP_URL || origin === env.PUBLIC_API_URL) return origin;
  if (env.NODE_ENV !== "production" && origin.startsWith("http://localhost")) return origin;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (hostIsAllowedSubdomain(parsed.hostname, env.PUBLIC_APP_DOMAIN)) return origin;
  if (hostIsAllowedSubdomain(parsed.hostname, env.PUBLIC_TENANT_DOMAIN)) return origin;
  return undefined;
}

function hostIsAllowedSubdomain(host: string, domain: string): boolean {
  if (!domain || domain === "localhost") return false;
  const normalisedHost = host.toLowerCase();
  const normalisedDomain = domain.replace(/^\./, "").toLowerCase();
  return normalisedHost === normalisedDomain || normalisedHost.endsWith(`.${normalisedDomain}`);
}

export function createApp() {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: allowedCorsOrigin,
      credentials: true,
      allowHeaders: ["content-type", "x-stewardledger-zone-slug"],
      exposeHeaders: ["content-disposition"],
    }),
  );

  app.route("/health", healthRouter);
  app.route("/api/public", publicRouter);
  app.route("/api/tenant", tenantRouter);
  app.route("/api/admin/administrators", adminAdministratorsRouter);
  app.route("/api/admin/audit-events", adminAuditRouter);
  app.route("/api/admin", adminErasureRouter);
  app.route("/api/admin", adminRouter);

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/", (c) => c.json({ service: "stewardledger-api", status: "ok" }));

  return app;
}

export type App = ReturnType<typeof createApp>;
