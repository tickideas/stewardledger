// packages/api/src/services/email.ts
// Branded transactional email. Wraps useSend in production, logs in dev.

import { BRAND_WORDMARK, APP_DOMAIN } from "@stewardledger/shared";
import { env } from "../env";
import { log } from "../logger";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. HTML bodies use brandedEmailHtml below. */
  body: string;
  html?: string;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!env.USESEND_API_KEY || !env.USESEND_API_URL) {
    log.info({ to: message.to, subject: message.subject }, "[dev] email not sent");
    log.debug({ body: message.body }, "[dev] email body");
    return;
  }

  // useSend client is added when we wire up production email.
  // Keeping the dev-only path in v0.1 so the auth flows work locally.
  log.warn(
    { to: message.to },
    "useSend integration pending — implement in packages/api/src/services/email.ts",
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function brandedEmailHtml(opts: { zoneName?: string; body: string }): string {
  const heading = opts.zoneName ? escapeHtml(opts.zoneName) : BRAND_WORDMARK;
  return `<!DOCTYPE html>
<html lang="en">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f6f8fb; margin:0; padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" style="padding:24px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <tr><td style="background:#0f1f3a; color:#ffffff; padding:24px;">
            <h1 style="margin:0; font-size:20px; font-weight:600;">${heading}</h1>
          </td></tr>
          <tr><td style="padding:32px 24px; color:#1f2937; line-height:1.6;">
            ${opts.body}
          </td></tr>
          <tr><td style="background:#f3f4f6; color:#6b7280; font-size:12px; text-align:center; padding:16px;">
            Sent via ${BRAND_WORDMARK} &middot; ${APP_DOMAIN}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
