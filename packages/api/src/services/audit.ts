// packages/api/src/services/audit.ts
// Append an audit row. Always called from inside a transaction when paired with
// a write so that the audit row commits atomically with the change.

import { auditEvents } from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

export interface AuditWrite {
  zoneId: string;
  actorUserId?: string | null;
  actorRoleCode?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAudit(database: Db, evt: AuditWrite): Promise<void> {
  await database.insert(auditEvents).values({
    zoneId: evt.zoneId,
    actorUserId: evt.actorUserId ?? null,
    actorRoleCode: evt.actorRoleCode ?? null,
    action: evt.action,
    entityType: evt.entityType,
    entityId: evt.entityId ?? null,
    before: (evt.before ?? null) as never,
    after: (evt.after ?? null) as never,
    reason: evt.reason ?? null,
    ipAddress: evt.ipAddress ?? null,
    userAgent: evt.userAgent ?? null,
    requestId: evt.requestId ?? null,
  });
}
