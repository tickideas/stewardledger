// packages/db/src/bootstrap-triggers.ts
// Idempotent application of database triggers that enforce hard rules from
// AGENTS.md and docs/DOMAIN-MODEL.md §6:
//   1. Posted contributions and their lines are immutable. The only allowed
//      mutation of a `posted` contribution is to mark it `voided` (with
//      void_reason and voided_at) or `reversed` (when a corrective row is
//      inserted referencing it via reversal_of_contribution_id).
//   2. A contribution_line's currency_code must match its parent contribution.
//      This guarantees mixed-currency reports never slip through silently.
//
// Per AGENTS.md hard rule #4 these are the only categories of trigger we
// permit: audit capture and posted-record immutability.
//
// Run after `db:push` (and after every schema-changing migration). Safe to
// call repeatedly.

import { sql } from "drizzle-orm";
import type { Database } from "./client";

export async function applyContributionTriggers(database: Database): Promise<void> {
  // Posted-immutability: only status/void/reverse columns and
  // updated_at/updated_by_user_id may change once status='posted'.
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

  await database.execute(sql`drop trigger if exists contributions_posted_guard on contributions;`);
  await database.execute(sql`
    create trigger contributions_posted_guard
      before update on contributions
      for each row
      execute function contributions_posted_guard();
  `);

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
  await database.execute(
    sql`drop trigger if exists contributions_no_delete_when_posted on contributions;`,
  );
  await database.execute(sql`
    create trigger contributions_no_delete_when_posted
      before delete on contributions
      for each row
      execute function contributions_no_delete_when_posted();
  `);

  // Lines: forbidden to insert/update/delete once the parent contribution is
  // posted. Corrections happen via a new contribution.
  await database.execute(sql`
    create or replace function contribution_lines_posted_guard() returns trigger
      language plpgsql
    as $$
    declare
      parent_status text;
      parent_currency text;
      target record;
    begin
      target := coalesce(new, old);
      select status, currency_code
        into parent_status, parent_currency
      from contributions
      where id = target.contribution_id;

      if parent_status is null then
        raise exception 'contribution_line.contribution_id % missing', target.contribution_id;
      end if;

      if tg_op in ('INSERT', 'UPDATE', 'DELETE') and parent_status = 'posted' then
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
  await database.execute(
    sql`drop trigger if exists contribution_lines_posted_guard on contribution_lines;`,
  );
  await database.execute(sql`
    create trigger contribution_lines_posted_guard
      before insert or update or delete on contribution_lines
      for each row
      execute function contribution_lines_posted_guard();
  `);
}
