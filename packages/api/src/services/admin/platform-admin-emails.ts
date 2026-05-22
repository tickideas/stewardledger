// packages/api/src/services/admin/platform-admin-emails.ts
// Outbound email templates for platform-admin invitations and grants.
// Split from platform-invitations.ts to keep that file under the
// AGENTS file-size guideline; everything here is presentation only.
//
// RELEVANT FILES: packages/api/src/services/admin/platform-invitations.ts, packages/api/src/services/email.ts

import { BRAND_WORDMARK } from "@stewardledger/shared";

import { env } from "../../env";
import { brandedEmailHtml, escapeHtml, sendEmail } from "../email";

export interface PlatformAdminInviteEmail {
  to: string;
  name: string;
  roleCode: string;
  superAdmin: boolean;
  token: string;
}

function platformInviteUrl(token: string): string {
  return `${env.PUBLIC_APP_URL}/invite/platform/${encodeURIComponent(token)}`;
}

export async function sendPlatformAdminInviteEmail(
  args: PlatformAdminInviteEmail,
): Promise<void> {
  const acceptUrl = platformInviteUrl(args.token);
  const roleLabel = args.superAdmin
    ? `${args.roleCode} + super-admin`
    : args.roleCode;
  await sendEmail({
    to: args.to,
    subject: `You've been invited to administer ${BRAND_WORDMARK}`,
    body:
      `Hi ${args.name},\n\n` +
      `You've been invited to administer ${BRAND_WORDMARK} as ${roleLabel}.\n\n` +
      `Click the link below to accept the invitation and set a password:\n` +
      `${acceptUrl}\n\n` +
      `This link expires in 7 days. If you weren't expecting this email, you can safely ignore it.`,
    html: brandedEmailHtml({
      body: `
        <p>Hi ${escapeHtml(args.name)},</p>
        <p>You've been invited to administer <strong>${escapeHtml(BRAND_WORDMARK)}</strong> as <code>${escapeHtml(roleLabel)}</code>.</p>
        <p>
          <a href="${acceptUrl}"
             style="display:inline-block;background:#0f1f3a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">
            Accept invitation
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">This link expires in 7 days. If you weren't expecting this email, you can safely ignore it.</p>
      `,
    }),
  });
}

/** Reserved for the "notify on grant" feature on existing-user grants. */
export async function sendPlatformAdminGrantNoticeEmail(args: {
  to: string;
  name: string | null;
  roleCode: string;
}): Promise<void> {
  await sendEmail({
    to: args.to,
    subject: `You've been granted ${args.roleCode} on ${BRAND_WORDMARK}`,
    body:
      `Hi ${args.name ?? "there"},\n\n` +
      `You've been granted the ${args.roleCode} platform role on ${BRAND_WORDMARK}. ` +
      `The new permissions take effect the next time you sign in.\n\n` +
      `If you weren't expecting this change, please contact your platform admin.`,
    html: brandedEmailHtml({
      body: `
        <p>Hi ${escapeHtml(args.name ?? "there")},</p>
        <p>You've been granted the <code>${escapeHtml(args.roleCode)}</code> platform role on <strong>${escapeHtml(BRAND_WORDMARK)}</strong>.</p>
        <p>The new permissions take effect the next time you sign in.</p>
        <p style="color:#6b7280;font-size:13px;">If you weren't expecting this change, please contact your platform admin.</p>
      `,
    }),
  });
}
