// packages/api/src/services/period-seed.ts
// Builds one calendar year of giving_period rows plus the fiscal/ministry/
// partnership periods needed to classify every date in that year.

import { and, eq } from "drizzle-orm";
import {
  fiscalPeriods,
  fiscalYears,
  givingPeriods,
  ministryPeriods,
  ministryYears,
  partnershipPeriods,
  partnershipYears,
} from "@stewardledger/db/schema";
import type { Db } from "@stewardledger/db";

interface ZonePeriodSettings {
  fiscalYearStartMonth: number;
  ministryYearStartMonth: number;
}

interface YearWindow {
  labelPrefix: string;
  startMonth: number;
  date: string;
}

interface PeriodRow {
  id: string;
  startDate: string;
  endDate: string;
}

const MS_PER_DAY = 86_400_000;

export async function seedZonePeriods(
  database: Db,
  zoneId: string,
  settings: ZonePeriodSettings,
  anchorDate = new Date(),
): Promise<void> {
  const calendarYear = anchorDate.getUTCFullYear();
  const startDate = `${calendarYear}-01-01`;
  const endDate = `${calendarYear}-12-31`;

  const fiscal = await ensureMonthlyCalendar(
    database,
    zoneId,
    "FY",
    settings.fiscalYearStartMonth,
    startDate,
    endDate,
    "fiscal",
  );
  const ministry = await ensureMonthlyCalendar(
    database,
    zoneId,
    "MY",
    settings.ministryYearStartMonth,
    startDate,
    endDate,
    "ministry",
  );
  const partnership = await ensureMonthlyCalendar(
    database,
    zoneId,
    "PY",
    1,
    startDate,
    endDate,
    "partnership",
  );

  const rows = datesBetween(startDate, endDate).map((date) => {
    const parts = dateParts(date);
    return {
      zoneId,
      date,
      weekday: parts.weekday,
      isoWeek: parts.isoWeek,
      isoYear: parts.isoYear,
      month: parts.month,
      quarter: Math.floor((parts.month - 1) / 3) + 1,
      fiscalPeriodId: findPeriod(fiscal, date).id,
      ministryPeriodId: findPeriod(ministry, date).id,
      partnershipPeriodId: findPeriod(partnership, date).id,
    };
  });

  await database.insert(givingPeriods).values(rows).onConflictDoNothing();
}

export async function deriveGivingPeriodForDate(
  database: Db,
  zoneId: string,
  date: string,
): Promise<typeof givingPeriods.$inferSelect | null> {
  const [row] = await database
    .select()
    .from(givingPeriods)
    .where(and(eq(givingPeriods.zoneId, zoneId), eq(givingPeriods.date, date)))
    .limit(1);
  return row ?? null;
}

async function ensureMonthlyCalendar(
  database: Db,
  zoneId: string,
  labelPrefix: string,
  startMonth: number,
  rangeStart: string,
  rangeEnd: string,
  kind: "fiscal" | "ministry" | "partnership",
): Promise<PeriodRow[]> {
  const windows = yearWindowsCovering({ labelPrefix, startMonth, date: rangeStart }, rangeEnd);
  const periods: PeriodRow[] = [];

  for (const window of windows) {
    if (kind === "fiscal") {
      const [year] = await database
        .insert(fiscalYears)
        .values({
          zoneId,
          yearLabel: window.yearLabel,
          startDate: window.startDate,
          endDate: window.endDate,
        })
        .onConflictDoNothing()
        .returning({ id: fiscalYears.id });
      const yearId =
        year?.id ??
        (
          await database
            .select({ id: fiscalYears.id })
            .from(fiscalYears)
            .where(and(eq(fiscalYears.zoneId, zoneId), eq(fiscalYears.yearLabel, window.yearLabel)))
            .limit(1)
        )[0].id;
      periods.push(...(await ensureFiscalPeriods(database, zoneId, yearId, window.startDate)));
    }

    if (kind === "ministry") {
      const [year] = await database
        .insert(ministryYears)
        .values({
          zoneId,
          yearLabel: window.yearLabel,
          startDate: window.startDate,
          endDate: window.endDate,
        })
        .onConflictDoNothing()
        .returning({ id: ministryYears.id });
      const yearId =
        year?.id ??
        (
          await database
            .select({ id: ministryYears.id })
            .from(ministryYears)
            .where(
              and(eq(ministryYears.zoneId, zoneId), eq(ministryYears.yearLabel, window.yearLabel)),
            )
            .limit(1)
        )[0].id;
      periods.push(...(await ensureMinistryPeriods(database, zoneId, yearId, window.startDate)));
    }

    if (kind === "partnership") {
      const [year] = await database
        .insert(partnershipYears)
        .values({
          zoneId,
          yearLabel: window.yearLabel,
          startDate: window.startDate,
          endDate: window.endDate,
        })
        .onConflictDoNothing()
        .returning({ id: partnershipYears.id });
      const yearId =
        year?.id ??
        (
          await database
            .select({ id: partnershipYears.id })
            .from(partnershipYears)
            .where(
              and(
                eq(partnershipYears.zoneId, zoneId),
                eq(partnershipYears.yearLabel, window.yearLabel),
              ),
            )
            .limit(1)
        )[0].id;
      periods.push(...(await ensurePartnershipPeriods(database, zoneId, yearId, window.startDate)));
    }
  }

  return periods;
}

async function ensureFiscalPeriods(
  database: Db,
  zoneId: string,
  fiscalYearId: string,
  startDate: string,
): Promise<PeriodRow[]> {
  await database
    .insert(fiscalPeriods)
    .values(monthlyPeriods(zoneId, fiscalYearId, startDate).map((p) => ({ ...p, fiscalYearId })))
    .onConflictDoNothing();
  return database
    .select({ id: fiscalPeriods.id, startDate: fiscalPeriods.startDate, endDate: fiscalPeriods.endDate })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.zoneId, zoneId), eq(fiscalPeriods.fiscalYearId, fiscalYearId)));
}

async function ensureMinistryPeriods(
  database: Db,
  zoneId: string,
  ministryYearId: string,
  startDate: string,
): Promise<PeriodRow[]> {
  await database
    .insert(ministryPeriods)
    .values(monthlyPeriods(zoneId, ministryYearId, startDate).map((p) => ({ ...p, ministryYearId })))
    .onConflictDoNothing();
  return database
    .select({
      id: ministryPeriods.id,
      startDate: ministryPeriods.startDate,
      endDate: ministryPeriods.endDate,
    })
    .from(ministryPeriods)
    .where(and(eq(ministryPeriods.zoneId, zoneId), eq(ministryPeriods.ministryYearId, ministryYearId)));
}

async function ensurePartnershipPeriods(
  database: Db,
  zoneId: string,
  partnershipYearId: string,
  startDate: string,
): Promise<PeriodRow[]> {
  await database
    .insert(partnershipPeriods)
    .values(
      monthlyPeriods(zoneId, partnershipYearId, startDate).map((p) => ({
        ...p,
        partnershipYearId,
      })),
    )
    .onConflictDoNothing();
  return database
    .select({
      id: partnershipPeriods.id,
      startDate: partnershipPeriods.startDate,
      endDate: partnershipPeriods.endDate,
    })
    .from(partnershipPeriods)
    .where(
      and(eq(partnershipPeriods.zoneId, zoneId), eq(partnershipPeriods.partnershipYearId, partnershipYearId)),
    );
}

function monthlyPeriods(zoneId: string, _yearId: string, startDate: string) {
  return Array.from({ length: 12 }, (_, index) => {
    const start = addMonths(startDate, index);
    return {
      zoneId,
      periodNumber: index + 1,
      startDate: start,
      endDate: addDays(addMonths(startDate, index + 1), -1),
    };
  });
}

function yearWindowsCovering(first: YearWindow, rangeEnd: string) {
  const firstDate = parseDate(first.date);
  const startYear =
    firstDate.getUTCMonth() + 1 >= first.startMonth
      ? firstDate.getUTCFullYear()
      : firstDate.getUTCFullYear() - 1;
  const windows: Array<{ yearLabel: string; startDate: string; endDate: string }> = [];
  let year = startYear;
  while (true) {
    const startDate = isoDate(new Date(Date.UTC(year, first.startMonth - 1, 1)));
    const endDate = addDays(addMonths(startDate, 12), -1);
    windows.push({ yearLabel: `${first.labelPrefix}${year}`, startDate, endDate });
    if (endDate >= rangeEnd) return windows;
    year += 1;
  }
}

function findPeriod(periods: PeriodRow[], date: string): PeriodRow {
  const period = periods.find((p) => p.startDate <= date && p.endDate >= date);
  if (!period) throw new Error(`No period found for ${date}`);
  return period;
}

function datesBetween(startDate: string, endDate: string): string[] {
  const start = parseDate(startDate).getTime();
  const end = parseDate(endDate).getTime();
  const dates: string[] = [];
  for (let time = start; time <= end; time += MS_PER_DAY) {
    dates.push(isoDate(new Date(time)));
  }
  return dates;
}

function dateParts(date: string) {
  const parsed = parseDate(date);
  const day = parsed.getUTCDay();
  const weekday = day === 0 ? 7 : day;
  const thursday = new Date(parsed);
  thursday.setUTCDate(parsed.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((thursday.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
  return {
    weekday,
    isoWeek,
    isoYear,
    month: parsed.getUTCMonth() + 1,
  };
}

function addMonths(date: string, months: number): string {
  const parsed = parseDate(date);
  return isoDate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months, 1)));
}

function addDays(date: string, days: number): string {
  const parsed = parseDate(date);
  return isoDate(new Date(parsed.getTime() + days * MS_PER_DAY));
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
