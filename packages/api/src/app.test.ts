// packages/api/src/app.test.ts
// Tests API-wide app concerns that are not specific to one route module.
// Covers CORS origin allowlisting for credentialed browser requests.
// RELEVANT FILES: packages/api/src/app.ts, packages/api/src/env.ts, packages/api/src/auth.ts

import { afterEach, describe, expect, it } from "vitest";
import { allowedCorsOrigin } from "./app";
import { env } from "./env";

const original = {
  NODE_ENV: env.NODE_ENV,
  PUBLIC_APP_URL: env.PUBLIC_APP_URL,
  PUBLIC_API_URL: env.PUBLIC_API_URL,
  PUBLIC_APP_DOMAIN: env.PUBLIC_APP_DOMAIN,
  PUBLIC_TENANT_DOMAIN: env.PUBLIC_TENANT_DOMAIN,
};

describe("allowedCorsOrigin", () => {
  afterEach(() => {
    Object.assign(env, original);
  });

  it("does not reflect arbitrary production origins", () => {
    Object.assign(env, {
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.stewardledger.test",
      PUBLIC_API_URL: "https://api.stewardledger.test",
      PUBLIC_APP_DOMAIN: "app.stewardledger.test",
      PUBLIC_TENANT_DOMAIN: "stewardledger.test",
    });

    expect(allowedCorsOrigin("https://evil.example")).toBeUndefined();
  });

  it("allows configured app/api origins and tenant subdomains", () => {
    Object.assign(env, {
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.stewardledger.test",
      PUBLIC_API_URL: "https://api.stewardledger.test",
      PUBLIC_APP_DOMAIN: "app.stewardledger.test",
      PUBLIC_TENANT_DOMAIN: "stewardledger.test",
    });

    expect(allowedCorsOrigin("https://app.stewardledger.test")).toBe("https://app.stewardledger.test");
    expect(allowedCorsOrigin("https://api.stewardledger.test")).toBe("https://api.stewardledger.test");
    expect(allowedCorsOrigin("https://grace.stewardledger.test")).toBe("https://grace.stewardledger.test");
  });
});
