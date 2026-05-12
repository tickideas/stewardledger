// packages/api/src/middleware/tenant.ts
// Resolves the current zone (tenant) from the Host header — subdomain or custom domain.
// Also accepts the zone header on the configured split API host.
// RELEVANT FILES: ./auth.ts, ../app.ts, ../../../web/src/lib/api.ts

import { zoneSlugSchema, type AuthorizedContext } from "@stewardledger/shared";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { customDomains, zones } from "@stewardledger/db/schema";
import { db } from "../db";
import { env } from "../env";
import { log } from "../logger";

export interface TenantBindings {
  zoneId: string;
  zoneSlug: string;
  regionId: string | null;
}

declare module "hono" {
  interface ContextVariableMap {
    tenant?: TenantBindings;
    auth?: AuthorizedContext;
  }
}

/** Resolve the zone slug from a Host header. */
export function resolveZoneSlugFromHost(host: string, tenantDomain: string): string | null {
  const lower = host.toLowerCase().split(":")[0];
  if (!lower.endsWith(`.${tenantDomain}`) && lower !== tenantDomain) return null;
  if (lower === tenantDomain) return null; // apex = marketing/platform, not a tenant
  const sub = lower.slice(0, lower.length - tenantDomain.length - 1);
  // Reserved subdomains never resolve to a tenant.
  if (sub === "www" || sub === "api" || sub === "demo" || sub === "admin" || sub === "marketing") {
    return null;
  }
  return sub;
}

export function resolveDevZoneSlugFromHeader(
  header: string | undefined,
  nodeEnv: string,
  tenantDomain: string,
): string | null {
  if (nodeEnv === "production" || tenantDomain !== "localhost") return null;
  return resolveZoneSlugFromHeader(header);
}

export function resolveZoneSlugFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const parsed = zoneSlugSchema.safeParse(header);
  return parsed.success ? parsed.data : null;
}

export function hostMatchesPublicApiOrigin(host: string, publicApiUrl: string): boolean {
  if (!host) return false;
  try {
    const apiHost = new URL(publicApiUrl).hostname.toLowerCase();
    return host.toLowerCase().split(":")[0] === apiHost;
  } catch {
    return false;
  }
}

/** Hono middleware that loads the tenant by Host header. */
export const tenantMiddleware: MiddlewareHandler = async (c: Context, next) => {
  const host = c.req.header("host") ?? "";
  if (!host) return c.json({ error: { code: "no_host", message: "Host header missing" } }, 400);

  const slug =
    resolveZoneSlugFromHost(host, env.PUBLIC_TENANT_DOMAIN) ??
    (hostMatchesPublicApiOrigin(host, env.PUBLIC_API_URL)
      ? resolveZoneSlugFromHeader(c.req.header("x-stewardledger-zone-slug"))
      : null) ??
    resolveDevZoneSlugFromHeader(
      c.req.header("x-stewardledger-zone-slug"),
      env.NODE_ENV,
      env.PUBLIC_TENANT_DOMAIN,
    );

  let tenant: TenantBindings | null = null;
  if (slug) {
    const rows = await db
      .select({ id: zones.id, slug: zones.slug, regionId: zones.regionId })
      .from(zones)
      .where(eq(zones.slug, slug))
      .limit(1);
    if (rows[0]) {
      tenant = { zoneId: rows[0].id, zoneSlug: rows[0].slug, regionId: rows[0].regionId };
    }
  }

  if (!tenant) {
    // Try custom domain
    const rows = await db
      .select({ id: zones.id, slug: zones.slug, regionId: zones.regionId })
      .from(customDomains)
      .innerJoin(zones, eq(customDomains.zoneId, zones.id))
      .where(eq(customDomains.hostname, host.toLowerCase().split(":")[0]))
      .limit(1);
    if (rows[0]) {
      tenant = { zoneId: rows[0].id, zoneSlug: rows[0].slug, regionId: rows[0].regionId };
    }
  }

  if (!tenant) {
    log.debug({ host }, "no tenant matched");
    return c.json({ error: { code: "tenant_not_found", message: "Unknown tenant" } }, 404);
  }

  c.set("tenant", tenant);
  await next();
};
