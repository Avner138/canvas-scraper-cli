import test from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  daysBetween,
  availableDays,
  ratePerDay,
  buildSchedule,
  occupancyOf,
  summarize,
} from "../core/schedule.js";

const items = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${i + 1}` }));
const dates = (plan) => plan.map((p) => p.date);

test("addDays crosses a spring-forward boundary without losing a day", () => {
  // 2026-03-08 is the US DST transition: a 23-hour day. Timestamp arithmetic
  // would land back on the 8th; calendar arithmetic must not.
  assert.equal(addDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2);
});

test("addDays crosses a fall-back boundary and a month and year end", () => {
  assert.equal(addDays("2026-11-01", 1), "2026-11-02"); // 25-hour day
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29"); // leap year
});

test("an even pace puts one item on each successive day", () => {
  const plan = buildSchedule(items(3), { start: "2026-10-01", perDay: 1 });
  assert.deepEqual(dates(plan), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.ok(plan.every((p) => p.source === "auto"));
});

test("perDay above one fills each day before moving on", () => {
  const plan = buildSchedule(items(5), { start: "2026-10-01", perDay: 2 });
  assert.deepEqual(dates(plan), [
    "2026-10-01", "2026-10-01",
    "2026-10-02", "2026-10-02",
    "2026-10-03",
  ]);
});

test("skipped weekdays are stepped over", () => {
  // 2026-10-03 is a Saturday, 2026-10-04 a Sunday.
  const plan = buildSchedule(items(3), {
    start: "2026-10-02",
    perDay: 1,
    skipWeekdays: [0, 6],
  });
  assert.deepEqual(dates(plan), ["2026-10-02", "2026-10-05", "2026-10-06"]);
});

test("a pinned date consumes capacity on its day, so auto items step past it", () => {
  // The crux rule. Without it, a day the user deliberately filled would
  // quietly receive another item on top.
  const plan = buildSchedule(items(3), {
    start: "2026-10-01",
    perDay: 1,
    pinned: new Map([["i2", "2026-10-01"]]),
  });
  const byId = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.equal(byId.i2.date, "2026-10-01");
  assert.equal(byId.i2.source, "manual");
  assert.equal(byId.i1.date, "2026-10-02", "the pin filled the 1st");
  assert.equal(byId.i3.date, "2026-10-03");
});

test("several pins on one day fill it that many times over", () => {
  const plan = buildSchedule(items(4), {
    start: "2026-10-01",
    perDay: 1,
    pinned: new Map([
      ["i2", "2026-10-01"],
      ["i3", "2026-10-01"],
    ]),
  });
  const byId = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.equal(byId.i1.date, "2026-10-02");
  assert.equal(byId.i4.date, "2026-10-03");
});

test("new items append into partly-filled days rather than starting a new one", () => {
  // A later scrape adds items; existing dates must not move, and a day with a
  // free slot should be topped up before the cursor rolls forward.
  const existing = [
    { targetDate: "2026-10-01" },
    { targetDate: "2026-10-02" },
    { targetDate: "2026-10-02" },
  ];
  const plan = buildSchedule(items(3), {
    start: "2026-10-01",
    perDay: 2,
    occupied: occupancyOf(existing),
  });
  assert.deepEqual(dates(plan), ["2026-10-01", "2026-10-03", "2026-10-03"]);
});

test("availableDays and ratePerDay agree about a deadline", () => {
  // Oct 1 2026 is a Thursday, so Oct 1-10 inclusive is 10 days containing
  // three weekend days (the 3rd, 4th and 10th) — seven usable.
  assert.equal(availableDays("2026-10-01", "2026-10-10"), 10);
  assert.equal(availableDays("2026-10-01", "2026-10-10", [0, 6]), 7);
  assert.equal(ratePerDay(20, "2026-10-01", "2026-10-10"), 2);
  assert.equal(ratePerDay(21, "2026-10-01", "2026-10-10"), 3, "rounds up");
  assert.equal(ratePerDay(5, "2026-10-01", "2026-10-10"), 1, "never below one");
});

test("a rate derived from an end date actually lands by that date", () => {
  const count = 221; // a real course
  const start = "2026-10-01";
  const end = "2026-12-15";
  const perDay = ratePerDay(count, start, end);
  const plan = buildSchedule(items(count), { start, perDay });
  assert.ok(
    plan[plan.length - 1].date <= end,
    `finished ${plan[plan.length - 1].date}, wanted <= ${end}`
  );
});

test("summarize counts overdue as undone-and-past, not merely late", () => {
  const tasks = [
    { targetDate: "2026-10-01", done: true },
    { targetDate: "2026-10-02", done: false },
    { targetDate: "2026-10-05", done: false },
    { targetDate: null, done: false },
    { targetDate: "2026-10-01", done: false, state: "removed" },
    { targetDate: "2026-10-01", done: false, orphan: true },
  ];
  const s = summarize(tasks, "2026-10-03");

  assert.equal(s.total, 4, "removed and orphaned tasks are excluded");
  assert.equal(s.done, 1);
  assert.equal(s.remaining, 3);
  assert.equal(s.overdue, 1, "only the undone one in the past");
  assert.equal(s.unscheduled, 1);
  assert.equal(s.percent, 25);
  assert.equal(s.finishBy, "2026-10-05");
});

test("summarize reports today's load separately from overdue", () => {
  const s = summarize(
    [
      { targetDate: "2026-10-03", done: false },
      { targetDate: "2026-10-03", done: true },
      { targetDate: "2026-10-02", done: false },
    ],
    "2026-10-03"
  );
  assert.equal(s.dueToday, 1, "a finished task is not still due");
  assert.equal(s.overdue, 1);
});

test("an empty plan summarizes without dividing by zero", () => {
  const s = summarize([], "2026-10-03");
  assert.equal(s.total, 0);
  assert.equal(s.percent, 0);
  assert.equal(s.finishBy, null);
});

/**
 * Plan entries must land on the same key the catalog uses.
 *
 * normalizeUrl drops the hash, which is right for an asset URL and wrong for
 * an item id: the catalog ids things that have no Canvas URL of their own by
 * appending a fragment — "<course url>#course" for the homepage, "<source>#<path>"
 * for each video file. Normalizing the whole string collapses every one of
 * those onto its base, so the date saves under a key nothing joins back to and
 * the task silently stays unscheduled. Caught exactly that way, on a real run.
 */
test("a plan entry keyed by a synthetic item id joins back to its task", async () => {
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const { updateEntries, readPlan } = await import("../core/plan.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-key-test-"));
  const courseItem = "https://canvas.mit.edu/courses/40983#course";
  const videoItem = "https://mitsloan.hosted.panopto.com/folder/1#VIDEOS/Lecture%201.mp4";

  updateEntries(root, [
    { itemId: courseItem, target_date: "2026-10-01" },
    { itemId: videoItem, target_date: "2026-10-02" },
    // A raw URL with a rotating verifier must still normalize onto its item.
    { itemId: "https://canvas.mit.edu/courses/40983/assignments/7?verifier=xyz", done: true },
  ]);

  const entries = readPlan(root).entries;
  assert.ok(entries[courseItem], "the #course fragment survives");
  assert.ok(entries[videoItem], "a video's #path fragment survives");
  assert.ok(
    entries["https://canvas.mit.edu/courses/40983/assignments/7"],
    "a rotating verifier is still stripped from a plain item URL"
  );
  assert.equal(Object.keys(entries).length, 3, "no two ids collapsed together");
});
