// packages/api/src/services/reports/email.ts
// Phase 7 PR 2 — branded "your export is ready / failed" email.
//
// Sent by the pg-boss subscriber after `finalizeJob` commits. We do
// NOT issue a signed URL in v1: the email deep-links into the per-
// report jobs panel, the user signs in (or already has a session),
// and the existing download endpoint re-checks `canExportReports`.
//
// `email_sent_at` on `report_jobs` is the idempotency guard — a
// pg-boss redeliver of a completed handler short-circuits before
// re-sending. Best-effort: a transient mail failure is logged and
// the row's `email_sent_at` stays NULL so a future redeliver or
// manual replay can try again.
//
// RELEVANT FILES: packages/api/src/services/email.ts, packages/api/src/services/reports/jobs.ts

import { and, eq, isNull } from "drizzle-orm";
import { BRAND_WORDMARK } from "@stewardledger/shared";
import {
  reportJobs,
  user as userTable,
  type ReportJob,
} from "@stewardledger/db/schema";
import type { Database } from "@stewardledger/db";
import { env } from "../../env";
import { log } from "../../logger";
import { brandedEmailHtml, escapeHtml, sendEmail } from "../email";
import { loadReportBranding } from "./branding";
import { getReport } from "./registry";

/**
 * Deep link the user back to the per-report jobs panel. The fragment
 * scrolls them straight to "My recent jobs" without us having to
 * ship a separate fully-qualified job URL. Falls back to the bare
 * report page when the fragment is unsupported by the user's mail
 * client (unusual).
 */
/**
 * Zone slugs are validated at creation (`zones.slug` is
 * lowercase-alphanumeric + hyphen). The shape is asserted again here
 * as defence-in-depth — a slug with a dot / uppercase / whitespace
 * would corrupt the `Host` header silently when shoved into `url.host`.
 * On a violation we fall back to the apex domain rather than 500.
 */
const SAFE_SLUG = /^[a-z0-9-]+$/;

function reportJobsUrl(zoneSlug: string, reportId: string): string {
  if (env.PUBLIC_TENANT_DOMAIN === "localhost") {
    return `${env.PUBLIC_APP_URL}/zone/reports/${encodeURIComponent(reportId)}#jobs`;
  }
  const url = new URL(env.PUBLIC_APP_URL);
  if (SAFE_SLUG.test(zoneSlug)) {
    url.host = `${zoneSlug}.${env.PUBLIC_TENANT_DOMAIN}`;
  } else {
    log.warn({ zoneSlug }, "report email: unsafe zone slug; using apex host");
  }
  url.pathname = `/zone/reports/${encodeURIComponent(reportId)}`;
  url.hash = "jobs";
  return url.toString();
}

interface SendArgs {
  job: ReportJob;
}

/**
 * Send the success / failure email for a finalized job. Idempotent:
 * a second call against the same `job` row no-ops because
 * `email_sent_at` is already set. The caller passes the row as it
 * stood after `finalizeJob`; we re-read inside a tx-less guard to
 * avoid double-sends across redeliveries.
 */
export async function sendReportJobEmail(
  database: Database,
  { job }: SendArgs,
): Promise<{ sent: boolean; reason?: string }> {
  if (job.status !== "completed" && job.status !== "failed") {
    return { sent: false, reason: "non-terminal" };
  }

  // Fresh read to defeat the redelivery race — between the worker
  // marking the row terminal and pg-boss re-driving the handler,
  // some other process may have already sent the mail.
  const [current] = await database
    .select({
      emailSentAt: reportJobs.emailSentAt,
      status: reportJobs.status,
    })
    .from(reportJobs)
    .where(eq(reportJobs.id, job.id))
    .limit(1);
  if (!current) return { sent: false, reason: "row-vanished" };
  if (current.emailSentAt) return { sent: false, reason: "already-sent" };

  const [recipient] = await database
    .select({ email: userTable.email, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, job.userId))
    .limit(1);
  if (!recipient) return { sent: false, reason: "user-missing" };

  let reportTitle = job.reportId;
  try {
    reportTitle = getReport(job.reportId).title;
  } catch {
    // A spec rename / removal between queue + run is unusual but
    // possible; fall back to the raw id so the user still gets
    // told what to look for.
  }

  let zoneSlug = job.zoneId;
  try {
    const branding = await loadReportBranding(database, job.zoneId);
    zoneSlug = branding.zoneSlug;
  } catch (err) {
    log.warn(
      { err, jobId: job.id },
      "report email: branding lookup failed; using zone id as slug",
    );
  }

  const link = reportJobsUrl(zoneSlug, job.reportId);
  const greeting = recipient.name ? `Hi ${recipient.name},` : "Hi,";
  const greetingHtml = recipient.name
    ? `<p>Hi ${escapeHtml(recipient.name)},</p>`
    : "<p>Hi,</p>";

  let subject: string;
  let text: string;
  let html: string;
  if (job.status === "completed") {
    subject = `Your ${reportTitle} export is ready`;
    text =
      `${greeting}\n\n` +
      `Your ${reportTitle} export is ready. It's available for the next 7 days.\n\n` +
      `Download it from your reports page:\n${link}\n\n` +
      `If you didn't request this, you can ignore this email.`;
    html = brandedEmailHtml({
      body: `
        ${greetingHtml}
        <p>Your <strong>${escapeHtml(reportTitle)}</strong> export is ready. It's available for the next 7 days.</p>
        <p>
          <a href="${link}"
             style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">
            Open ${escapeHtml(BRAND_WORDMARK)}
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can ignore this email.</p>
      `,
    });
  } else {
    const reason =
      job.errorMessage && job.errorMessage.trim().length > 0
        ? job.errorMessage
        : "An unexpected error stopped the export.";
    subject = `Your ${reportTitle} export failed`;
    text =
      `${greeting}\n\n` +
      `Your ${reportTitle} export couldn't be generated.\n\n` +
      `Reason: ${reason}\n\n` +
      `You can retry from your reports page:\n${link}`;
    html = brandedEmailHtml({
      body: `
        ${greetingHtml}
        <p>Your <strong>${escapeHtml(reportTitle)}</strong> export couldn't be generated.</p>
        <p style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px 14px;border-radius:6px;">
          ${escapeHtml(reason)}
        </p>
        <p>
          <a href="${link}"
             style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">
            Retry from reports
          </a>
        </p>
      `,
    });
  }

  const result = await sendEmail({ to: recipient.email, subject, body: text, html });
  // The dev-log transport returns `ok: false, reason: 'missing-config'`
  // — we still mark `email_sent_at` so a redeliver doesn't spam the
  // log loop. Only treat a hard send failure (network / http) as a
  // reason to leave the column null.
  const handledByDevLog =
    !result.ok && result.transport === "dev-log" && result.reason === "missing-config";
  if (result.ok || handledByDevLog) {
    // Self-guarding UPDATE: only stamp if the column is still null.
    // Defence-in-depth against a pg-boss redeliver overlapping a
    // long send — `singletonKey` + worker concurrency=1 already
    // serialize handlers, this just makes the database the final
    // arbiter.
    const stamped = await database
      .update(reportJobs)
      .set({ emailSentAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(reportJobs.id, job.id), isNull(reportJobs.emailSentAt)),
      )
      .returning({ id: reportJobs.id });
    if (stamped.length === 0) return { sent: false, reason: "already-sent" };
    return { sent: result.ok, reason: handledByDevLog ? "dev-log" : undefined };
  }

  log.warn(
    {
      jobId: job.id,
      transport: result.transport,
      reason: "reason" in result ? result.reason : undefined,
    },
    "report email: send failed; will retry on next redeliver",
  );
  return { sent: false, reason: "send-failed" };
}
