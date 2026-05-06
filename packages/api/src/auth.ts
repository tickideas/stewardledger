// packages/api/src/auth.ts
// Better Auth configuration. Email + password, email OTP, magic link.

import { BRAND_WORDMARK, OTP_VALIDITY_MINUTES } from "@stewardledger/shared";
import * as schema from "@stewardledger/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, magicLink } from "better-auth/plugins";
import { db } from "./db";
import { env } from "./env";
import { log } from "./logger";
import { sendEmail } from "./services/email";

export const auth = betterAuth({
  appName: BRAND_WORDMARK,
  baseURL: env.PUBLIC_API_URL,
  secret: env.AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: env.NODE_ENV === "production",
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: `Reset your ${BRAND_WORDMARK} password`,
        body: `Click to reset: ${url}`,
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: `Verify your ${BRAND_WORDMARK} email`,
        body: `Click to verify: ${url}`,
      });
    },
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: OTP_VALIDITY_MINUTES * 60,
      sendVerificationOTP: async ({ email, otp }) => {
        log.debug({ email }, "sending OTP");
        await sendEmail({
          to: email,
          subject: `Your ${BRAND_WORDMARK} sign-in code`,
          body: `Your code: ${otp}`,
        });
      },
    }),
    magicLink({
      expiresIn: 5 * 60,
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          subject: `Sign in to ${BRAND_WORDMARK}`,
          body: `Click to sign in: ${url}`,
        });
      },
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
