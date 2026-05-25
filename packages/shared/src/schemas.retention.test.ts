// packages/shared/src/schemas.retention.test.ts
// Vitest coverage for the per-zone retention policy schema + default
// hydrator. The hydrator is the contract every consumer relies on: a
// brand-new zone reads `{}` and gets the v1 defaults.
// RELEVANT FILES: ./schemas.ts

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION_POLICY,
  RETENTION_DIMENSIONS,
  hydrateRetentionPolicy,
  zoneRetentionPolicySchema,
} from "./schemas";

describe("zoneRetentionPolicySchema", () => {
  it("accepts an empty object", () => {
    const out = zoneRetentionPolicySchema.parse({});
    expect(out).toEqual({});
  });

  it("accepts a fully-specified policy", () => {
    const out = zoneRetentionPolicySchema.parse({
      audit_events: { retainDays: 365 },
      import_files: { retainDays: 30 },
      import_rows: { retainDays: 30 },
      report_jobs: { retainDays: 7 },
      member_soft_deletes: { retainDays: 0 },
    });
    expect(out.audit_events?.retainDays).toBe(365);
  });

  it("rejects negative retainDays", () => {
    expect(() =>
      zoneRetentionPolicySchema.parse({ audit_events: { retainDays: -1 } }),
    ).toThrow();
  });

  it("rejects retainDays above the 100-year cap", () => {
    expect(() =>
      zoneRetentionPolicySchema.parse({ audit_events: { retainDays: 36501 } }),
    ).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() =>
      zoneRetentionPolicySchema.parse({ bogus: { retainDays: 1 } }),
    ).toThrow();
  });

  it("rejects unknown nested keys (strict)", () => {
    expect(() =>
      zoneRetentionPolicySchema.parse({
        audit_events: { retainDays: 1, extra: true },
      }),
    ).toThrow();
  });

  it("coerces stringified integers (from form posts)", () => {
    const out = zoneRetentionPolicySchema.parse({
      audit_events: { retainDays: "365" },
    });
    expect(out.audit_events?.retainDays).toBe(365);
  });
});

describe("hydrateRetentionPolicy", () => {
  it("returns the defaults when the column is empty / null", () => {
    expect(hydrateRetentionPolicy(null)).toEqual(DEFAULT_RETENTION_POLICY);
    expect(hydrateRetentionPolicy(undefined)).toEqual(DEFAULT_RETENTION_POLICY);
    expect(hydrateRetentionPolicy({})).toEqual(DEFAULT_RETENTION_POLICY);
  });

  it("overlays per-dimension overrides on the defaults", () => {
    const out = hydrateRetentionPolicy({ audit_events: { retainDays: 30 } });
    expect(out.audit_events.retainDays).toBe(30);
    // Untouched dimensions keep their defaults.
    expect(out.import_files.retainDays).toBe(
      DEFAULT_RETENTION_POLICY.import_files.retainDays,
    );
    expect(out.report_jobs.retainDays).toBe(
      DEFAULT_RETENTION_POLICY.report_jobs.retainDays,
    );
  });

  it("emits a fresh object so callers can mutate it safely", () => {
    const a = hydrateRetentionPolicy({});
    const b = hydrateRetentionPolicy({});
    a.audit_events.retainDays = 1;
    expect(b.audit_events.retainDays).toBe(
      DEFAULT_RETENTION_POLICY.audit_events.retainDays,
    );
  });

  it("covers every declared dimension", () => {
    const out = hydrateRetentionPolicy({});
    for (const dim of RETENTION_DIMENSIONS) {
      expect(out[dim]).toBeDefined();
      expect(typeof out[dim].retainDays).toBe("number");
    }
  });
});
