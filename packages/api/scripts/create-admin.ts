// packages/api/scripts/create-admin.ts
// Creates a Better Auth user with super-admin privileges. Useful for
// bootstrapping the platform-admin dashboard before any /signup flow has
// run, and for the demo.
//
// Usage:
//   read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
//   pnpm create-admin -- --email you@example.com --password-env ADMIN_PASSWORD --name 'You'
//
// If the email already exists this script REFUSES by default. Pass
// --elevate-existing to confirm you really meant to grant platform-wide
// super-admin to a pre-existing user (e.g. a real tenant owner). The
// script prints that user's current zone bindings before elevating so
// the operator can sanity-check.

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, isNull, and } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
config({ path: resolve(repoRoot, ".env") });

// Better Auth + db are imported after env is loaded. We use the long-lived
// `db` from src/db.ts so that auth and db share the same connection; the
// process exits via `process.exit` because Better Auth doesn't expose a
// shutdown hook for its internal adapter pool.
const { auth } = await import("../src/auth");
const { db } = await import("../src/db");
const schema = await import("@stewardledger/db/schema");

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const email = arg("email");
const passwordFromArg = arg("password");
const passwordEnv = arg("password-env");
const password = passwordEnv ? process.env[passwordEnv] : passwordFromArg;
const name = arg("name") ?? "Admin";
const elevateExisting = flag("elevate-existing");

if (!email || !password) {
  console.error(
    "Usage: pnpm create-admin -- --email <email> --password-env <ENV_VAR> [--name <name>] [--elevate-existing]",
  );
  console.error(
    "Avoid --password on the command line; argv may leak through shell history/process listings.",
  );
  process.exit(1);
}

if (passwordFromArg) {
  console.warn(
    "Warning: --password can leak through shell history/process listings. Prefer --password-env <ENV_VAR>.",
  );
}

async function main(): Promise<void> {
  const existing = await db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      name: schema.user.name,
      isSuperAdmin: schema.user.isSuperAdmin,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .where(eq(schema.user.email, email!))
    .limit(1);

  let userId: string;
  if (existing[0]) {
    if (!elevateExisting) {
      // Surface who they are; refuse without explicit consent.
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
            eq(schema.userRoleBindings.userId, existing[0].id),
            isNull(schema.userRoleBindings.revokedAt),
          ),
        );
      console.error(`Refusing: user ${email} already exists.`);
      console.error(`  id=${existing[0].id}`);
      console.error(`  name=${existing[0].name}`);
      console.error(`  isSuperAdmin=${existing[0].isSuperAdmin}`);
      console.error(`  createdAt=${existing[0].createdAt.toISOString()}`);
      if (bindings.length === 0) {
        console.error(`  no zone bindings`);
      } else {
        console.error(`  zone bindings:`);
        for (const b of bindings) {
          console.error(`    - ${b.zoneSlug} (${b.zoneName}) as ${b.roleCode}`);
        }
      }
      console.error(
        `\nRe-run with --elevate-existing if you really want to grant platform super-admin to this user.`,
      );
      process.exitCode = 1;
      return;
    }
    userId = existing[0].id;
    console.log(`User ${email} already exists (id=${userId}); elevating to super-admin.`);
  } else {
    const result = await auth.api.signUpEmail({
      body: { name, email: email!, password: password! },
      asResponse: false,
    });
    userId = result.user.id;
    console.log(`Created user ${email} (id=${userId}).`);
  }

  await db
    .update(schema.user)
    .set({ isSuperAdmin: true })
    .where(eq(schema.user.id, userId));

  console.log(`OK: ${email} is now super-admin.`);
}

try {
  await main();
} catch (err) {
  console.error("[create-admin] failed:", err);
  process.exitCode = 1;
}
// Better Auth's drizzle adapter keeps the pool alive; explicit exit is the
// only reliable way to terminate. Both branches above set process.exitCode.
process.exit(process.exitCode ?? 0);
