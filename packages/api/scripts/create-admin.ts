// packages/api/scripts/create-admin.ts
// Creates a Better Auth user with super-admin privileges. Useful for
// bootstrapping the platform-admin dashboard before any /signup flow has
// run, and for the demo.
//
// Usage:
//   pnpm create-admin -- --email you@example.com --password 'hunter22!' --name 'You'
//
// If the email already exists, just elevates the existing account to
// super-admin (idempotent).

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
config({ path: resolve(repoRoot, ".env") });

// Better Auth + db must be imported after env is loaded.
const { auth } = await import("../src/auth");
const { db } = await import("../src/db");
const schema = await import("@stewardledger/db/schema");

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return argv[i + 1];
}

const email = arg("email");
const password = arg("password");
const name = arg("name") ?? "Admin";

if (!email || !password) {
  console.error("Usage: pnpm create-admin -- --email <email> --password <password> [--name <name>]");
  process.exit(1);
}

try {
  // Check whether the user already exists; if so, just elevate.
  const existing = await db
    .select({ id: schema.user.id, isSuperAdmin: schema.user.isSuperAdmin })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);

  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
    console.log(`User ${email} already exists, elevating.`);
  } else {
    const result = await auth.api.signUpEmail({
      body: { name, email, password },
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
} catch (err) {
  console.error("[create-admin] failed:", err);
  process.exitCode = 1;
} finally {
  // Better Auth holds a pool internally; just exit.
  process.exit(process.exitCode ?? 0);
}
