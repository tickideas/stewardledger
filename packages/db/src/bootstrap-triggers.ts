// packages/db/src/bootstrap-triggers.ts
// Idempotent application of database triggers that enforce the contribution
// invariants documented in AGENTS.md hard rules #3 and #4 and DOMAIN-MODEL.md §6:
//
//   1. Posted contributions and their lines are immutable. The only allowed
//      mutation of a `posted` contribution is to mark it `voided` (with
//      void_reason and voided_at) or `reversed` (when a corrective row is
//      inserted referencing it via reversal_of_contribution_id).
//   2. A contribution_line's currency_code must match its parent contribution
//      (currency-cohesion). This guarantees mixed-currency reports never slip
//      through silently and is, per AGENTS.md hard rule #4, the kind of
//      cross-row invariant that warrants a trigger rather than a CHECK.
//   3. TRUNCATE on contributions / contribution_lines is unconditionally
//      forbidden so that a runaway migration cannot wipe posted financial
//      records out from under the per-row immutability triggers.
//
// All triggers raise SQLSTATE 23514 (`check_violation`). Tests can assert on
// that code rather than the message text.
//
// Run after `db:push` (and after every schema-changing migration). Safe to
// call repeatedly. The function definitions below also re-`ENABLE` each
// trigger after recreating it so a crashed test run that left a trigger
// disabled (see contributions.test.ts cleanup) self-heals on the next
// bootstrap.

import { sql } from "drizzle-orm";
import type { Database, Db } from "./client";

interface TriggerSpec {
  table: string;
  name: string;
  /** Full `create trigger …` statement, minus the trailing semicolon. */
  body: string;
}

async function installTrigger(database: Db, spec: TriggerSpec): Promise<void> {
  await database.execute(sql.raw(`drop trigger if exists ${spec.name} on ${spec.table};`));
  await database.execute(sql.raw(`${spec.body};`));
  // Re-enabling is a no-op for a freshly-created trigger but recovers from a
  // crashed test run that left the trigger disabled.
  await database.execute(sql.raw(`alter table ${spec.table} enable trigger ${spec.name};`));
}

// Stable session-advisory lock key. Anything constant is fine; just must be
// identical across every caller. `hashtext` gives us an int4 derived from a
// fixed string, which won't collide with the per-zone member-code lock or
// the merge-proposal lock (those use uuid hashes) at integer level.
const CONTRIBUTION_TRIGGER_BOOTSTRAP_LOCK_TAG = "stewardledger.applyContributionTriggers";

export async function applyContributionTriggers(database: Database): Promise<void> {
  // Concurrent callers (e.g. parallel vitest test files in different worker
  // threads) all race `drop trigger ... ; create trigger ...` against the
  // same catalog row, tripping Postgres' "tuple concurrently updated"
  // (XX000). Serialize the whole bootstrap inside one transaction so the
  // advisory lock + DDL share one pooled connection — a session-level
  // `pg_advisory_lock` / `pg_advisory_unlock` pair across the pool can
  // route to different connections, leaking the lock and skipping
  // serialisation. `pg_advisory_xact_lock` releases automatically on commit.
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${CONTRIBUTION_TRIGGER_BOOTSTRAP_LOCK_TAG}))`,
    );
    await applyContributionTriggersUnlocked(tx);
  });
}

async function applyContributionTriggersUnlocked(database: Db): Promise<void> {
  // Posted-immutability: only status/void/reverse columns and
  // updated_at/updated_by_user_id may change once status='posted'.
  // `region_id` is intentionally NOT in the allow-list — it is set at insert
  // time from the home chapter's zone region and is treated as write-once
  // post-posting. Fan-out region updates run against draft contributions
  // only.
  await database.execute(sql`
    create or replace function contributions_posted_guard() returns trigger
      language plpgsql
    as $$
    declare
      allowed_new contributions%rowtype;
    begin
      if old.status <> 'posted' then
        return new;
      end if;

      -- Allow the row to transition to voided or reversed; the corrective
      -- record itself is a separate insert with reversal_of_contribution_id.
      if new.status not in ('posted', 'voided', 'reversed') then
        raise exception
          'contribution % is posted; status may only become voided or reversed (got %)',
          old.id, new.status
          using errcode = 'check_violation';
      end if;

      -- Build the candidate row that would be allowed: same as OLD except for
      -- the void/reverse columns + status + updated_* bookkeeping.
      allowed_new := old;
      allowed_new.status := new.status;
      allowed_new.voided_at := new.voided_at;
      allowed_new.voided_by_user_id := new.voided_by_user_id;
      allowed_new.void_reason := new.void_reason;
      allowed_new.updated_at := new.updated_at;
      allowed_new.updated_by_user_id := new.updated_by_user_id;

      if (allowed_new is distinct from new) then
        raise exception
          'contribution % is posted and immutable except for void/reverse fields',
          old.id
          using errcode = 'check_violation';
      end if;

      return new;
    end;
    $$;
  `);

  await installTrigger(database, {
    table: "contributions",
    name: "contributions_posted_guard",
    body: `create trigger contributions_posted_guard
      before update on contributions
      for each row
      execute function contributions_posted_guard()`,
  });

  await database.execute(sql`
    create or replace function contributions_no_delete_when_posted() returns trigger
      language plpgsql
    as $$
    begin
      if old.status = 'posted' then
        raise exception
          'contribution % is posted; delete is forbidden (use void/reverse)', old.id
          using errcode = 'check_violation';
      end if;
      return old;
    end;
    $$;
  `);
  await installTrigger(database, {
    table: "contributions",
    name: "contributions_no_delete_when_posted",
    body: `create trigger contributions_no_delete_when_posted
      before delete on contributions
      for each row
      execute function contributions_no_delete_when_posted()`,
  });

  // TRUNCATE bypasses BEFORE DELETE row triggers. Block it unconditionally so
  // a runaway migration or owner-priv connection cannot wipe posted rows.
  await database.execute(sql`
    create or replace function contributions_no_truncate() returns trigger
      language plpgsql
    as $$
    begin
      raise exception 'truncate on contributions is forbidden'
        using errcode = 'check_violation';
    end;
    $$;
  `);
  await installTrigger(database, {
    table: "contributions",
    name: "contributions_no_truncate",
    body: `create trigger contributions_no_truncate
      before truncate on contributions
      for each statement
      execute function contributions_no_truncate()`,
  });

  // Lines: forbidden to insert/update/delete once the parent contribution is
  // posted, and currency_code must match the parent. Corrections happen via
  // a new contribution row.
  await database.execute(sql`
    create or replace function contribution_lines_posted_guard() returns trigger
      language plpgsql
    as $$
    declare
      parent_status text;
      parent_currency text;
      target record;
    begin
      if tg_op = 'DELETE' then
        target := old;
      else
        target := new;
      end if;

      -- Bind the parent lookup to the same zone as the line so the trigger
      -- remains correct even if FK validation is ever bypassed.
      select status, currency_code
        into parent_status, parent_currency
      from contributions
      where id = target.contribution_id and zone_id = target.zone_id;

      -- If the parent is not visible in this zone, defer to the FK constraint
      -- (which raises 23503) for INSERT/UPDATE, and allow DELETE through —
      -- DELETEs land here during ON DELETE CASCADE after the parent row is
      -- already gone, and refusing them would break the cascade.
      if parent_status is null then
        return target;
      end if;

      if parent_status = 'posted' then
        raise exception
          'contribution % is posted; lines are immutable', target.contribution_id
          using errcode = 'check_violation';
      end if;

      if tg_op in ('INSERT', 'UPDATE') and target.currency_code <> parent_currency then
        raise exception
          'contribution_line.currency_code (%) must match contribution.currency_code (%)',
          target.currency_code, parent_currency
          using errcode = 'check_violation';
      end if;

      return target;
    end;
    $$;
  `);
  await installTrigger(database, {
    table: "contribution_lines",
    name: "contribution_lines_posted_guard",
    body: `create trigger contribution_lines_posted_guard
      before insert or update or delete on contribution_lines
      for each row
      execute function contribution_lines_posted_guard()`,
  });

  await database.execute(sql`
    create or replace function contribution_lines_no_truncate() returns trigger
      language plpgsql
    as $$
    begin
      raise exception 'truncate on contribution_lines is forbidden'
        using errcode = 'check_violation';
    end;
    $$;
  `);
  await installTrigger(database, {
    table: "contribution_lines",
    name: "contribution_lines_no_truncate",
    body: `create trigger contribution_lines_no_truncate
      before truncate on contribution_lines
      for each statement
      execute function contribution_lines_no_truncate()`,
  });
}
