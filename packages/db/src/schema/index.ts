// packages/db/src/schema/index.ts
// Schema barrel for Drizzle. Tables are organised by bounded context.
// Phase 1 only includes identity, regions, zones, chapters, roles, and audit.
// Other contexts (members, giving, contributions, imports, targets, billing)
// are added in subsequent phases per docs/ROADMAP.md.

export * from "./auth";
export * from "./regions";
export * from "./zones";
export * from "./chapters";
export * from "./groups";
export * from "./roles";
export * from "./invitations";
export * from "./lookups";
export * from "./members";
export * from "./families";
export * from "./periods";
export * from "./giving";
export * from "./contributions";
export * from "./batch-templates";
export * from "./imports";
export * from "./targets";
export * from "./paying-in-books";
export * from "./saved-report-filters";
export * from "./report-jobs";
export * from "./zone-exports";
export * from "./erasure-requests";
export * from "./platform-invitations";
export * from "./audit";
