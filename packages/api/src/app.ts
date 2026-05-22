// packages/api/src/app.ts
// Hono app factory. Mounts routes and Better Auth.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { env } from "./env";
import { adminAdministratorsRouter } from "./routes/admin-administrators";
import { adminRouter } from "./routes/admin";
import { healthRouter } from "./routes/health";
import { publicRouter } from "./routes/public";
import { tenantRouter } from "./routes/tenant";

export function createApp() {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.PUBLIC_APP_URL;
        if (origin === env.PUBLIC_APP_URL) return origin;
        if (env.NODE_ENV !== "production" && origin.startsWith("http://localhost")) return origin;
        // Tenant subdomains are trusted via Better Auth trustedOrigins.
        return origin;
      },
      credentials: true,
      allowHeaders: ["content-type", "x-stewardledger-zone-slug"],
    }),
  );

  app.route("/health", healthRouter);
  app.route("/api/public", publicRouter);
  app.route("/api/tenant", tenantRouter);
  app.route("/api/admin", adminAdministratorsRouter);
  app.route("/api/admin", adminRouter);

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/", (c) => c.json({ service: "stewardledger-api", status: "ok" }));

  return app;
}

export type App = ReturnType<typeof createApp>;
