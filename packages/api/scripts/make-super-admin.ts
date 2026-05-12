// packages/api/scripts/make-super-admin.ts
// Elevate an existing Better Auth user to platform super-admin. The user
// must already exist (they signed up via /signup or accepted an invite).
//
// Usage:
//   pnpm make-super-admin -- you@example.com
//   pnpm make-super-admin -- you@example.com --revoke

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
config({ path: resolve(repoRoot, ".env") });

const { db } = await import("../src/db");
const schema = await import("@stewardledger/db/schema");

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const revoke = args.includes("--revoke");

if (!email) {
  console.error("Usage: pnpm make-super-admin -- <email> [--revoke]");
  process.exit(1);
}

try {
  const rows = await db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      isSuperAdmin: schema.user.isSuperAdmin,
    })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (rows.length === 0) {
    console.error(
      `No user found with email ${email}. Sign them up first at /signup or accept an invite.`,
    );
    process.exit(1);
  }
  const target = rows[0];
  const next = !revoke;
  if (target.isSuperAdmin === next) {
    console.log(`User ${email} is already ${next ? "super-admin" : "not super-admin"}; no change.`);
  } else {
    await db
      .update(schema.user)
      .set({ isSuperAdmin: next })
      .where(eq(schema.user.id, target.id));
    console.log(`Updated ${email}: is_super_admin = ${next}`);
  }
} catch (err) {
  console.error("[make-super-admin] failed:", err);
  process.exitCode = 1;
}
// The shared `db` keeps its pool alive; explicit exit is the only way to
// terminate the script process.
process.exit(process.exitCode ?? 0);
