// packages/api/src/services/exports/email.ts
// Phase 9 §3 — "your zone export is ready / failed" notification.
//
// Sent by the pg-boss subscriber after `finalizeExport` commits. We
// do NOT issue a signed URL in v1: the email deep-links to the
// owner-only `/zone/settings` panel, the user signs in (or has a
// session), and the download endpoint re-checks ownership.
//
// `zone_exports.email_sent_at` is the idempotency guard — a
// pg-boss redeliver of a completed handler short-circuits before
// re-sending. Best-effort: a transient mail failure is logged and
// the row's `email_sent_at` stays NULL so a future redeliver or
// manual replay can try again.
//
// Mirrors `services/reports/email.ts` deliberately so the operator
// has only one mental model for "tenant async-job email".
//
// RELEVANT FILES: ../email.ts, ./jobs.ts

import { and, eq, isNull } from "drizzle-orm";
import {
  user as userTable,
  zoneExports,
  zones,
  type ZoneExport,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { env } from "../../env";
import { log } from "../../logger";
import { brandedEmailHtml, escapeHtml, sendEmail } from "../email";

const SAFE_SLUG = /^[a-z0-9-]+$/;

/**
 * Deep link to the owner-only export panel. Falls back to the apex
 * domain when the slug fails the safety regex (defensive — zones
 * are slug-validated at creation, but a future migration could
 * loosen the rule and we don't want to corrupt the `Host` header).
 */
function exportSettingsUrl(zoneSlug: string): string {
  if (env.PUBLIC_TENANT_DOMAIN === "localhost") {
    return `${env.PUBLIC_APP_URL}/zone/settings#exports`;
  }
  const url = new URL(env.PUBLIC_APP_URL);
  if (SAFE_SLUG.test(zoneSlug)) {
    url.host = `${zoneSlug}.${env.PUBLIC_TENANT_DOMAIN}`;
  } else {
    log.warn({ zoneSlug }, "zone export email: unsafe zone slug; using apex host");
  }
  url.pathname = "/zone/settings";
  url.hash = "exports";
  return url.toString();
}

interface SendArgs {
  job: ZoneExport;
}

/**
 * Send the success / failure email for a finalized bundle.
 * Idempotent: a second call against the same row no-ops because
 * `email_sent_at` is already set. A self-guarding UPDATE makes the
 * database the final arbiter against pg-boss redelivery races.
 */
export async function sendZoneExportEmail(
  database: Database,
  { job }: SendArgs,
): Promise<{ sent: boolean; reason?: string }> {
  if (job.status !== "completed" && job.status !== "failed") {
    return { sent: false, reason: "non-terminal" };
  }
  if (!job.requestedByUserId) {
    // The requester was deleted between request + completion. The
    // bundle still exists in storage and the audit trail still
    // points to the original actor by id (preserved before the
    // user-row delete cascaded `set null` here); we simply have
    // nobody to email.
    return { sent: false, reason: "requester-deleted" };
  }

  // Fresh read defeats the redelivery race — between the worker
  // marking the row terminal and pg-boss re-driving the handler,
  // some other process may have already sent the mail.
  const [current] = await database
    .select({
      emailSentAt: zoneExports.emailSentAt,
      status: zoneExports.status,
    })
    .from(zoneExports)
    .where(eq(zoneExports.id, job.id))
    .limit(1);
  if (!current) return { sent: false, reason: "row-vanished" };
  if (current.emailSentAt) return { sent: false, reason: "already-sent" };

  const [recipient] = await database
    .select({ email: userTable.email, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, job.requestedByUserId))
    .limit(1);
  if (!recipient) return { sent: false, reason: "user-missing" };

  // Zone lookup is mandatory: without a real slug the deep link
  // would be a UUID subdomain that 404s. Skip the email entirely
  // in that case — the row stays NULL on `email_sent_at` so a
  // manual replay (once the operator fixes whatever caused the
  // zone row to vanish) can re-send.
  let zoneRow: { slug: string; name: string } | undefined;
  try {
    [zoneRow] = await database
      .select({ slug: zones.slug, name: zones.name })
      .from(zones)
      .where(eq(zones.id, job.zoneId))
      .limit(1);
  } catch (err) {
    log.warn(
      { err, exportId: job.id },
      "zone export email: zone lookup failed",
    );
  }
  if (!zoneRow) {
    return { sent: false, reason: "zone-missing" };
  }
  const zoneSlug = zoneRow.slug;
  const zoneName = zoneRow.name;

  const link = exportSettingsUrl(zoneSlug);
  const greeting = recipient.name ? `Hi ${recipient.name},` : "Hi,";
  const greetingHtml = recipient.name
    ? `<p>Hi ${escapeHtml(recipient.name)},</p>`
    : "<p>Hi,</p>";
  const zoneLabel = zoneName;

  let subject: string;
  let text: string;
  let html: string;
  if (job.status === "completed") {
    subject = `Your ${zoneLabel} data export is ready`;
    text =
      `${greeting}\n\n` +
      `Your full data export for ${zoneLabel} is ready. It will remain available for 7 days.\n\n` +
      `Open it from your zone settings:\n${link}\n\n` +
      `If you didn't request this, please contact your zone administrator.`;
    html = brandedEmailHtml({
      zoneName,
      body: `
        ${greetingHtml}
        <p>Your full data export for <strong>${escapeHtml(zoneLabel)}</strong> is ready. It will remain available for 7 days.</p>
        <p>
          <a href="${link}"
             style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">
            Open zone settings
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">If you didn't request this, please contact your zone administrator.</p>
      `,
    });
  } else {
    const reason =
      job.errorMessage && job.errorMessage.trim().length > 0
        ? job.errorMessage
        : "An unexpected error stopped the export.";
    subject = `Your ${zoneLabel} data export failed`;
    text =
      `${greeting}\n\n` +
      `Your data export for ${zoneLabel} couldn't be generated.\n\n` +
      `Reason: ${reason}\n\n` +
      `You can retry from your zone settings:\n${link}`;
    html = brandedEmailHtml({
      zoneName,
      body: `
        ${greetingHtml}
        <p>Your data export for <strong>${escapeHtml(zoneLabel)}</strong> couldn't be generated.</p>
        <p style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px 14px;border-radius:6px;">
          ${escapeHtml(reason)}
        </p>
        <p>
          <a href="${link}"
             style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">
            Retry from zone settings
          </a>
        </p>
      `,
    });
  }

  const result = await sendEmail({ to: recipient.email, subject, body: text, html });
  const handledByDevLog =
    !result.ok && result.transport === "dev-log" && result.reason === "missing-config";
  if (result.ok || handledByDevLog) {
    const stamped = await database
      .update(zoneExports)
      .set({ emailSentAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(zoneExports.id, job.id), isNull(zoneExports.emailSentAt)),
      )
      .returning({ id: zoneExports.id });
    if (stamped.length === 0) return { sent: false, reason: "already-sent" };
    return { sent: result.ok, reason: handledByDevLog ? "dev-log" : undefined };
  }

  log.warn(
    {
      exportId: job.id,
      transport: result.transport,
      reason: "reason" in result ? result.reason : undefined,
    },
    "zone export email: send failed; will retry on next redeliver",
  );
  return { sent: false, reason: "send-failed" };
}
