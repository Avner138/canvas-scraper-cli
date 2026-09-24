/**
 * Even-pace scheduling for a study plan.
 *
 * Pure and dependency-free so it can be unit-tested offline and shared
 * byte-for-byte with the browser.
 *
 * ── Dates are local-time YYYY-MM-DD strings, everywhere ───────────────────
 * Including on the wire. All arithmetic goes through a local-midnight Date,
 * never UTC: a planner that slips a day across a daylight-saving boundary is a
 * planner nobody trusts, and "2026-03-08" plus one day must be "2026-03-09" in
 * March in New York just as reliably as in June.
 */

/** Parses "YYYY-MM-DD" into a local-midnight Date. */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Formats a Date as a local "YYYY-MM-DD". */
export function formatDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today, local. */
export function today() {
  return formatDay(new Date());
}

/** Tomorrow, local — the default start, so nothing is ever scheduled today. */
export function tomorrow() {
  return addDays(today(), 1);
}

/**
 * Adds days to a "YYYY-MM-DD".
 *
 * Constructs a new local Date from the parts rather than mutating a timestamp,
 * so a DST transition (a 23- or 25-hour day) cannot shift the result.
 */
export function addDays(day, n) {
  const d = parseDay(day);
  if (!d) return day;
  return formatDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Whole days from `a` to `b`, by calendar date rather than elapsed hours. */
export function daysBetween(a, b) {
  const da = parseDay(a);
  const db = parseDay(b);
  if (!da || !db) return 0;
  return Math.round((db - da) / 86400000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day) {
  const d = parseDay(day);
  return d ? d.getDay() : 0;
}

/** How many usable days from `start` to `end` inclusive, minus skipped days. */
export function availableDays(start, end, skipWeekdays = []) {
  const total = daysBetween(start, end);
  if (total < 0) return 0;
  let n = 0;
  for (let i = 0; i <= total; i++) {
    if (!skipWeekdays.includes(weekday(addDays(start, i)))) n++;
  }
  return n;
}

/**
 * The per-day rate needed to finish `count` items between `start` and `end`.
 * At least 1 — a plan that asks for zero a day never finishes.
 */
export function ratePerDay(count, start, end, skipWeekdays = []) {
  const days = availableDays(start, end, skipWeekdays);
  if (!days) return Math.max(1, count);
  return Math.max(1, Math.ceil(count / days));
}

/**
 * Assigns a target date to each item, in order, at `perDay` per day.
 *
 * @param {Array<{id: string}>} items in the order they should be worked
 * @param {object} opts
 * @param {string} [opts.start] first eligible day (default tomorrow)
 * @param {number} [opts.perDay]
 * @param {number[]} [opts.skipWeekdays] e.g. [0, 6] for weekends
 * @param {Map<string,string>} [opts.pinned] itemId -> date the user fixed
 * @param {Map<string,number>} [opts.occupied] date -> slots already taken
 * @returns {Array<{id: string, date: string, source: "auto"|"manual"}>}
 */
export function buildSchedule(items, opts = {}) {
  const {
    start = tomorrow(),
    perDay = 1,
    skipWeekdays = [],
    pinned = new Map(),
    occupied = new Map(),
  } = opts;

  const rate = Math.max(1, Number(perDay) || 1);
  const capacity = new Map(occupied);

  // A date the user fixed consumes a slot on its day. This is the rule that
  // makes the result feel right rather than merely even: pin three things to
  // Friday at one a day and Friday is full three times over, so the automatic
  // cursor steps past it instead of quietly stacking a fourth on top.
  for (const date of pinned.values()) {
    capacity.set(date, (capacity.get(date) || 0) + 1);
  }

  let cursor = start;
  const out = [];
  let guard = 0;
  for (const item of items) {
    if (pinned.has(item.id)) {
      out.push({ id: item.id, date: pinned.get(item.id), source: "manual" });
      continue;
    }
    while (
      (skipWeekdays.includes(weekday(cursor)) || (capacity.get(cursor) || 0) >= rate) &&
      guard++ < 100000
    ) {
      cursor = addDays(cursor, 1);
    }
    capacity.set(cursor, (capacity.get(cursor) || 0) + 1);
    out.push({ id: item.id, date: cursor, source: "auto" });
  }
  return out;
}

/** Slots already taken per day by a set of tasks that carry target dates. */
export function occupancyOf(tasks) {
  const out = new Map();
  for (const t of tasks || []) {
    if (!t || !t.targetDate) continue;
    out.set(t.targetDate, (out.get(t.targetDate) || 0) + 1);
  }
  return out;
}

/**
 * Progress against a plan, including whether it is actually on track.
 *
 * "Overdue" counts only undone tasks whose date has passed — a task finished
 * late is finished, and a plan that keeps scolding you about it is one you
 * stop reading.
 */
export function summarize(tasks, now = today()) {
  const live = (tasks || []).filter((t) => t.state !== "removed" && !t.orphan);
  const done = live.filter((t) => t.done);
  const dated = live.filter((t) => t.targetDate);
  const overdue = live.filter((t) => !t.done && t.targetDate && t.targetDate < now);
  const dueToday = live.filter((t) => !t.done && t.targetDate === now);
  const remaining = live.length - done.length;

  let finishBy = null;
  for (const t of dated) {
    if (t.done) continue;
    if (!finishBy || t.targetDate > finishBy) finishBy = t.targetDate;
  }

  return {
    total: live.length,
    done: done.length,
    remaining,
    scheduled: dated.length,
    unscheduled: live.length - dated.length,
    overdue: overdue.length,
    dueToday: dueToday.length,
    percent: live.length ? Math.round((done.length / live.length) * 100) : 0,
    finishBy,
  };
}

export default {
  buildSchedule,
  summarize,
  occupancyOf,
  ratePerDay,
  availableDays,
  addDays,
  daysBetween,
  today,
  tomorrow,
  formatDay,
  parseDay,
  weekday,
};
