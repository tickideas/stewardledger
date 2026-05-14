// packages/api/src/auth.ts
// Better Auth configuration. Email + password, email OTP, magic link.

import { BRAND_WORDMARK, OTP_VALIDITY_MINUTES } from "@stewardledger/shared";
import * as schema from "@stewardledger/db/schema";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, magicLink, twoFactor } from "better-auth/plugins";
import { db } from "./db";
import { env } from "./env";
import { log } from "./logger";
import { brandedEmailHtml, escapeHtml, sendEmail } from "./services/email";
import { recordMfaAudit } from "./services/mfa-audit";

// Cross-subdomain cookie support. Enabled only when AUTH_COOKIE_DOMAIN is
// set in env — e.g. `.example.com` to share the session cookie between
// `app.example.com` (web) and `api.example.com` (API). Leave unset for
// same-origin deployments.

/**
 * Better Auth generates verification URLs that point at the API origin
 * (the verify endpoint is on the API) and embeds a `callbackURL` query
 * param for the post-verify redirect. By default that callback is just
 * `/`, which means "the API origin" — the user lands on the API JSON
 * health blurb. Rewriting it here forces the redirect onto the web app.
 *
 * Leaves the verify URL itself untouched (it must hit the API).
 */
function withWebCallback(url: string, fallbackPath: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("callbackURL", `${env.PUBLIC_APP_URL}${fallbackPath}`);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Branded HTML body for a single-action auth email. The CTA is a primary
 * button; the URL is also rendered verbatim below so users on email
 * clients that strip links can still copy/paste.
 */
function authActionEmailHtml(opts: { intro: string; ctaLabel: string; url: string; tail?: string }): string {
  const safeUrl = escapeHtml(opts.url);
  return brandedEmailHtml({
    body: `
      <p style="margin:0 0 16px;">${opts.intro}</p>
      <p style="margin:24px 0;">
        <a href="${safeUrl}" style="display:inline-block; padding:12px 20px; background:#a87432; color:#ffffff; text-decoration:none; border-radius:4px; font-weight:500;">${escapeHtml(opts.ctaLabel)}</a>
      </p>
      <p style="margin:16px 0 8px; color:#6b7280; font-size:13px;">Or paste this link into your browser:</p>
      <p style="margin:0 0 16px; word-break:break-all; font-size:12px;"><a href="${safeUrl}" style="color:#0f1f3a;">${safeUrl}</a></p>
      ${opts.tail ? `<p style="margin:16px 0 0; color:#6b7280; font-size:12px;">${opts.tail}</p>` : ""}
    `,
  });
}

// Cross-subdomain cookie support marker (kept here so the constant below
// stays adjacent to the helpers it depends on).
const crossSubDomainCookies = env.AUTH_COOKIE_DOMAIN
  ? { enabled: true as const, domain: env.AUTH_COOKIE_DOMAIN }
  : undefined;

export const auth = betterAuth({
  appName: BRAND_WORDMARK,
  baseURL: env.PUBLIC_API_URL,
  secret: env.AUTH_SECRET,
  advanced: crossSubDomainCookies ? { crossSubDomainCookies } : undefined,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      twoFactor: schema.twoFactor,
    },
  }),
  /**
   * Database-level hooks fire after Better Auth commits its writes.
   * The MFA enable / disable flow touches `user.two_factor_enabled`;
   * this hook fans out a `user.mfa_enable` / `user.mfa_disable`
   * audit row to every zone the user belongs to. We deliberately
   * audit on the change — not on every user update — by comparing
   * the inbound partial against a cached pre-image read in the
   * `before` hook.
   *
   * Audit failure is logged but does not throw: the user write has
   * already committed and rolling it back from this side-channel
   * would leave the account half-armed. The Better Auth response is
   * still successful; ops sees the missing row in monitoring.
   */
  databaseHooks: {
    user: {
      update: {
        before: async (data, ctx) => {
          if (!ctx) return;
          if (!("twoFactorEnabled" in data)) return;
          const userId = ctx.context?.session?.user?.id;
          if (!userId) return;
          // Cache the previous value so the `after` hook can
          // emit an event only when the flag actually flips.
          const [row] = await db
            .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
            .from(schema.user)
            .where(eq(schema.user.id, userId))
            .limit(1);
          (ctx as unknown as { __mfaPrev?: boolean }).__mfaPrev =
            row?.twoFactorEnabled === true;
        },
        after: async (updated, ctx) => {
          if (!ctx) return;
          if (!("twoFactorEnabled" in updated)) return;
          const userId = (updated as { id?: string }).id;
          if (!userId) return;
          const next = (updated as { twoFactorEnabled?: boolean })
            .twoFactorEnabled === true;
          const prev = (ctx as unknown as { __mfaPrev?: boolean })
            .__mfaPrev;
          if (prev === next) return;
          try {
            await recordMfaAudit(db, {
              userId,
              enabled: next,
              actorUserId: ctx.context?.session?.user?.id ?? userId,
              ipAddress: ctx.request?.headers.get("x-forwarded-for") ?? null,
              userAgent: ctx.request?.headers.get("user-agent") ?? null,
            });
          } catch (err) {
            log.error(
              { err, userId, enabled: next },
              "mfa-audit hook failed; user state already changed",
            );
          }
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: env.NODE_ENV === "production",
    sendResetPassword: async ({ user, url }) => {
      const link = withWebCallback(url, "/login");
      await sendEmail({
        to: user.email,
        subject: `Reset your ${BRAND_WORDMARK} password`,
        body: `Reset your password: ${link}\n\nIf you didn't request this, you can ignore this email.`,
        html: authActionEmailHtml({
          intro: `Someone (hopefully you) asked to reset the password on your ${escapeHtml(BRAND_WORDMARK)} account. Click below to choose a new one.`,
          ctaLabel: "Reset password",
          url: link,
          tail: "If you didn't request this, you can safely ignore this email \u2014 your password won't change.",
        }),
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      const link = withWebCallback(url, "/login?verified=1");
      await sendEmail({
        to: user.email,
        subject: `Verify your ${BRAND_WORDMARK} email`,
        body: `Verify your email: ${link}`,
        html: authActionEmailHtml({
          intro: `Welcome to ${escapeHtml(BRAND_WORDMARK)}. Confirm this is your email address to activate your account.`,
          ctaLabel: "Verify email",
          url: link,
          tail: "This link expires in one hour.",
        }),
      });
    },
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: OTP_VALIDITY_MINUTES * 60,
      sendVerificationOTP: async ({ email, otp }) => {
        log.debug({ email }, "sending OTP");
        const safeOtp = escapeHtml(otp);
        await sendEmail({
          to: email,
          subject: `Your ${BRAND_WORDMARK} sign-in code`,
          body: `Your sign-in code is ${otp}. It expires in ${OTP_VALIDITY_MINUTES} minutes.`,
          html: brandedEmailHtml({
            body: `
              <p style="margin:0 0 16px;">Use this code to finish signing in to ${escapeHtml(BRAND_WORDMARK)}:</p>
              <p style="margin:24px 0; text-align:center;">
                <span style="display:inline-block; padding:14px 24px; background:#f3f4f6; border:1px solid #e5e7eb; border-radius:6px; font-family: 'SFMono-Regular', Menlo, monospace; font-size:28px; letter-spacing:6px; color:#0f1f3a;">${safeOtp}</span>
              </p>
              <p style="margin:0; color:#6b7280; font-size:12px;">The code expires in ${OTP_VALIDITY_MINUTES} minutes. If you didn't request it, you can ignore this email.</p>
            `,
          }),
        });
      },
    }),
    magicLink({
      expiresIn: 5 * 60,
      sendMagicLink: async ({ email, url }) => {
        const link = withWebCallback(url, "/");
        await sendEmail({
          to: email,
          subject: `Sign in to ${BRAND_WORDMARK}`,
          body: `Sign in: ${link}\n\nThis link expires in 5 minutes.`,
          html: authActionEmailHtml({
            intro: `Click the button below to finish signing in to ${escapeHtml(BRAND_WORDMARK)}.`,
            ctaLabel: "Sign in",
            url: link,
            tail: "This link expires in 5 minutes and can only be used once.",
          }),
        });
      },
    }),
    /**
     * TOTP-based two-factor authentication. Enrolment is currently
     * gated to super-admins on the UI side (`/account/security`) —
     * Better Auth's after-hook only challenges `/sign-in/email`, not
     * the OTP / magic-link paths, so an MFA-enrolled user can still
     * sign in unchallenged via those routes. PR 2 will plug that
     * gap and lift the super-admin gate. See `tasks/totp-mfa.md`.
     *
     * `skipVerificationOnEnable: false` (default) means the user
     * must enter a fresh TOTP code before MFA arms — a typo'd
     * authenticator setup cannot lock the user out.
     *
     * `issuer` ships as the static brand wordmark in PR 1. PR 2,
     * when MFA opens to zone-bound users, should pass a per-call
     * `issuer` override from /two-factor/enable so authenticator
     * apps differentiate zones for users who administer several.
     */
    twoFactor({
      issuer: BRAND_WORDMARK,
    }),
  ],
  trustedOrigins: () => {
    const origins = new Set<string>([env.PUBLIC_APP_URL, env.PUBLIC_API_URL]);
    if (env.NODE_ENV !== "production") {
      origins.add("http://localhost:5173");
      origins.add("http://localhost:3000");
    }
    return [...origins];
  },
});

export type Auth = typeof auth;
