// packages/api/src/app.ts
// Hono app factory. Mounts routes and Better Auth.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { env } from "./env";
import { healthRouter } from "./routes/health";

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
    }),
  );

  app.route("/health", healthRouter);

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/", (c) => c.json({ service: "stewardledger-api", status: "ok" }));

  return app;
}

export type App = ReturnType<typeof createApp>;
