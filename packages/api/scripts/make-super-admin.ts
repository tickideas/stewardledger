// packages/api/scripts/make-super-admin.ts
// Elevate an existing Better Auth user to platform super-admin. The user
// must already exist (they accepted an invitation or were created via
// `pnpm create-admin`).
//
// Usage:
//   pnpm make-super-admin -- you@example.com --confirm
//   pnpm make-super-admin -- you@example.com --revoke

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
config({ path: resolve(repoRoot, ".env") });

const { db } = await import("../src/db");
const schema = await import("@stewardledger/db/schema");

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const revoke = args.includes("--revoke");
const confirm = args.includes("--confirm");

if (!email) {
  console.error("Usage: pnpm make-super-admin -- <email> (--confirm | --revoke)");
  process.exit(1);
}

if (!revoke && !confirm) {
  console.error(
    "Refusing to grant platform super-admin without --confirm. This permission can read across zones.",
  );
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
      `No user found with email ${email}. Have them accept an invitation first, or create the user via 'pnpm create-admin'.`,
    );
    process.exit(1);
  }
  const target = rows[0];
  const bindings = await db
    .select({
      zoneSlug: schema.zones.slug,
      zoneName: schema.zones.name,
      roleCode: schema.roles.code,
    })
    .from(schema.userRoleBindings)
    .innerJoin(schema.zones, eq(schema.zones.id, schema.userRoleBindings.zoneId))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoleBindings.roleId))
    .where(
      and(
        eq(schema.userRoleBindings.userId, target.id),
        isNull(schema.userRoleBindings.revokedAt),
        isNull(schema.zones.deletedAt),
      ),
    );

  console.log(`Target user: ${email} (id=${target.id})`);
  console.log(`Current is_super_admin = ${target.isSuperAdmin}`);
  if (bindings.length === 0) {
    console.log("Active zone bindings: none");
  } else {
    console.log("Active zone bindings:");
    for (const b of bindings) {
      console.log(`  - ${b.zoneSlug} (${b.zoneName}) as ${b.roleCode}`);
    }
  }

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
