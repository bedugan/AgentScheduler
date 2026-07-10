import type { IsoTimestamp, RunCadence } from "./domain.js";

const MAX_MINUTES_TO_SEARCH = 60 * 24 * 366 * 5;

interface CronField {
  values: Set<number>;
  unrestricted: boolean;
}

interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function nextRunAtAfter(
  cadence: RunCadence,
  after: Date,
): IsoTimestamp {
  switch (cadence.type) {
    case "cron":
      return nextCronRunAtAfter(cadence.expression, after);
  }
}

function nextCronRunAtAfter(expression: string, after: Date): IsoTimestamp {
  const cron = parseCronExpression(expression);
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let minute = 0; minute < MAX_MINUTES_TO_SEARCH; minute += 1) {
    if (matchesCronExpression(cron, candidate)) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error(
    `Cron expression '${expression}' did not produce a run within five years.`,
  );
}

function parseCronExpression(expression: string): ParsedCronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron expression '${expression}' must contain five fields.`,
    );
  }

  return {
    minute: parseCronField(parts[0]!, 0, 59),
    hour: parseCronField(parts[1]!, 0, 23),
    dayOfMonth: parseCronField(parts[2]!, 1, 31),
    month: parseCronField(parts[3]!, 1, 12),
    dayOfWeek: parseCronField(parts[4]!, 0, 7, normalizeDayOfWeek),
  };
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  normalizeValue: (value: number) => number = (value) => value,
): CronField {
  const values = new Set<number>();

  for (const segment of field.split(",")) {
    const trimmedSegment = segment.trim();
    if (trimmedSegment.length === 0) {
      throw new Error(`Cron field '${field}' contains an empty segment.`);
    }

    const [rangeSource, stepSource] = trimmedSegment.split("/");
    if (rangeSource === undefined) {
      throw new Error(`Cron field '${field}' contains an invalid segment.`);
    }

    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Cron field '${field}' contains an invalid step.`);
    }

    const [start, end] =
      rangeSource === "*"
        ? [min, max]
        : parseCronRange(rangeSource, min, max);

    for (let value = start; value <= end; value += step) {
      values.add(normalizeValue(value));
    }
  }

  return {
    values,
    unrestricted: field === "*",
  };
}

function parseCronRange(
  source: string,
  min: number,
  max: number,
): [number, number] {
  const [startSource, endSource] = source.split("-");
  const start = parseCronNumber(startSource, min, max);
  const end =
    endSource === undefined ? start : parseCronNumber(endSource, min, max);

  if (end < start) {
    throw new Error(`Cron range '${source}' cannot count backwards.`);
  }

  return [start, end];
}

function parseCronNumber(
  source: string | undefined,
  min: number,
  max: number,
): number {
  const value = Number(source);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Cron value '${source ?? ""}' must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
}

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function matchesCronExpression(
  cron: ParsedCronExpression,
  date: Date,
): boolean {
  if (!cron.minute.values.has(date.getUTCMinutes())) {
    return false;
  }
  if (!cron.hour.values.has(date.getUTCHours())) {
    return false;
  }
  if (!cron.month.values.has(date.getUTCMonth() + 1)) {
    return false;
  }

  const dayOfMonthMatches = cron.dayOfMonth.values.has(date.getUTCDate());
  const dayOfWeekMatches = cron.dayOfWeek.values.has(date.getUTCDay());

  if (cron.dayOfMonth.unrestricted && cron.dayOfWeek.unrestricted) {
    return true;
  }
  if (cron.dayOfMonth.unrestricted) {
    return dayOfWeekMatches;
  }
  if (cron.dayOfWeek.unrestricted) {
    return dayOfMonthMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}
