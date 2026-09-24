import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import catalog, { CATALOG_FILE } from "../scrapers/catalog.js";

/** A throwaway course folder. */
function tmpCourse() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "catalog-test-"));
}

const COURSE = {
  id: "40983",
  name: "15.722 Applied Economics for Managers",
  url: "https://canvas.mit.edu/courses/40983",
};

/** Scrapes one item with one file into an open catalog. */
function recordItem(dir, spec, fileName = "MODULE.pdf") {
  const token = catalog.beginItem(spec);
  const itemDir = path.join(dir, spec.category, spec.section, spec.titleSafe);
  fs.mkdirSync(itemDir, { recursive: true });
  catalog.noteDir(itemDir);
  const file = path.join(itemDir, fileName);
  fs.writeFileSync(file, "x");
  catalog.file(file, { role: "page" });
  catalog.endItem(token);
  return file;
}

const MODULE_A = {
  url: "https://canvas.mit.edu/courses/40983/modules/items/1",
  title: "Week 1: Supply & Demand",
  titleSafe: "Week 1- Supply & Demand",
  category: "MODULES",
  kind: "module",
  section: "Module I",
  sectionOrdinal: 1,
  ordinal: 1,
};

const ASSIGN_A = {
  url: "https://canvas.mit.edu/courses/40983/assignments/7",
  title: "Problem Set 1",
  titleSafe: "Problem Set 1",
  category: "ASSIGNMENTS",
  kind: "assignment",
  section: "Problem Sets",
  sectionOrdinal: 1,
  ordinal: 1,
};

test("an item records its title, folder and files, and survives a reload", () => {
  const dir = tmpCourse();
  catalog.load(dir, COURSE);
  recordItem(dir, MODULE_A);
  catalog.reconcile(new Set(["MODULES"]));
  catalog.save();
  catalog.reset();

  const raw = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE)));
  assert.equal(raw.version, 1);
  assert.equal(raw.items.length, 1);
  const item = raw.items[0];
  // The raw title is kept alongside the filesystem-safe one: ":" becomes "-"
  // on disk, and the UI should show what the instructor actually wrote.
  assert.equal(item.title, "Week 1: Supply & Demand");
  assert.equal(item.title_safe, "Week 1- Supply & Demand");
  assert.equal(item.category, "MODULES");
  assert.equal(item.state, "present");
  assert.equal(item.dir, "MODULES/Module I/Week 1- Supply & Demand");
  assert.equal(item.files.length, 1);
  assert.equal(item.files[0].path, "MODULES/Module I/Week 1- Supply & Demand/MODULE.pdf");
  assert.equal(item.files[0].role, "page");
  assert.equal(item.files[0].type, "pdf");
});

test("the id is the normalized item URL, so a rotated link still matches", () => {
  const dir = tmpCourse();
  catalog.load(dir, COURSE);
  recordItem(dir, MODULE_A);
  catalog.save();
  const first = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items[0].id;
  catalog.reset();

  // Same item, but Canvas handed us a fresh verifier token this time.
  catalog.load(dir, COURSE);
  recordItem(dir, { ...MODULE_A, url: `${MODULE_A.url}?verifier=abc123` });
  catalog.save();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE)));
  catalog.reset();

  assert.equal(raw.items.length, 1, "a rotated verifier must not fork the item");
  assert.equal(raw.items[0].id, first);
});

test("a partial run carries forward categories it did not scrape", () => {
  const dir = tmpCourse();
  // Full run: both categories.
  catalog.load(dir, COURSE);
  recordItem(dir, MODULE_A);
  recordItem(dir, ASSIGN_A, "ASSIGNMENT.pdf");
  catalog.reconcile(new Set(["MODULES", "ASSIGNMENTS"]));
  catalog.save();
  catalog.reset();

  // Assignments-only re-run. The modules item must survive untouched.
  catalog.load(dir, COURSE);
  recordItem(dir, ASSIGN_A, "ASSIGNMENT.pdf");
  const counts = catalog.reconcile(new Set(["ASSIGNMENTS"]));
  catalog.save();
  catalog.reset();

  const items = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items;
  assert.equal(counts.carried, 1);
  assert.equal(counts.removed, 0);
  assert.equal(items.length, 2);
  const mod = items.find((i) => i.category === "MODULES");
  assert.equal(mod.state, "present", "an un-scraped category is not 'removed'");
  assert.equal(mod.files.length, 1, "its files are carried forward too");
});

test("an item gone from a scraped category is flagged removed, not deleted", () => {
  const dir = tmpCourse();
  catalog.load(dir, COURSE);
  recordItem(dir, MODULE_A);
  catalog.reconcile(new Set(["MODULES"]));
  catalog.save();
  catalog.reset();

  // Re-run the same category; the instructor has unpublished the item.
  catalog.load(dir, COURSE);
  const counts = catalog.reconcile(new Set(["MODULES"]));
  catalog.save();
  catalog.reset();

  const items = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items;
  assert.equal(counts.removed, 1);
  assert.equal(items.length, 1, "the item is kept so a completed task survives");
  assert.equal(items[0].state, "removed");
  assert.equal(items[0].files.length, 1, "its file list is kept for reference");
});

test("items sort into course order: category, then section, then position", () => {
  const dir = tmpCourse();
  catalog.load(dir, COURSE);
  // Recorded out of order on purpose.
  recordItem(dir, { ...MODULE_A, url: `${MODULE_A.url}/b`, titleSafe: "b", sectionOrdinal: 2, ordinal: 1 });
  recordItem(dir, { ...MODULE_A, url: `${MODULE_A.url}/c`, titleSafe: "c", sectionOrdinal: 1, ordinal: 2 });
  recordItem(dir, ASSIGN_A, "ASSIGNMENT.pdf");
  recordItem(dir, { ...MODULE_A, url: `${MODULE_A.url}/a`, titleSafe: "a", sectionOrdinal: 1, ordinal: 1 });
  catalog.save();
  catalog.reset();

  const items = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items;
  assert.deepEqual(
    items.map((i) => `${i.category}:${i.section_ordinal}.${i.ordinal}`),
    ["ASSIGNMENTS:1.1", "MODULES:1.1", "MODULES:1.2", "MODULES:2.1"]
  );
});

test("a file recorded with no open item lands on the course, not nowhere", () => {
  const dir = tmpCourse();
  catalog.load(dir, COURSE);
  const home = path.join(dir, "HOMEPAGE.pdf");
  fs.writeFileSync(home, "x");
  catalog.file(home, { role: "page" });
  catalog.save();
  catalog.reset();

  const items = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "course-home");
  assert.equal(items[0].files[0].path, "HOMEPAGE.pdf");
});

test("a catalog written by a newer version is rebuilt, not half-read", () => {
  const dir = tmpCourse();
  fs.writeFileSync(
    path.join(dir, CATALOG_FILE),
    JSON.stringify({ version: 99, items: [{ id: "x", title: "from the future" }] })
  );
  catalog.load(dir, COURSE);
  const counts = catalog.reconcile(new Set(["MODULES"]));
  catalog.reset();
  assert.equal(counts.carried, 0, "an unknown version contributes no prior items");
});

test("endItem with a stale token refuses to close the wrong item", () => {
  const dir = tmpCourse();
  catalog.load(dir, COURSE);
  const a = catalog.beginItem(MODULE_A);
  catalog.endItem(a);
  const b = catalog.beginItem(ASSIGN_A);
  catalog.endItem(a); // stale — must not close b

  const f = path.join(dir, "late.pdf");
  fs.writeFileSync(f, "x");
  catalog.file(f);
  catalog.endItem(b);
  catalog.save();
  catalog.reset();

  const items = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items;
  const assign = items.find((i) => i.category === "ASSIGNMENTS");
  assert.equal(assign.files.length, 1, "the file still belongs to the open item");
  assert.equal(assign.files[0].path, "late.pdf");
});

test("registerTree enumerates media from disk, so a resumed run keeps them", () => {
  const dir = tmpCourse();
  const videos = path.join(dir, "VIDEOS", "Lectures");
  fs.mkdirSync(videos, { recursive: true });
  fs.writeFileSync(path.join(videos, "Lecture 1.mp4"), "x");
  fs.writeFileSync(path.join(videos, "Lecture 2.mp4"), "x");
  fs.writeFileSync(path.join(videos, "notes.txt"), "x"); // not media

  // Run twice: yt-dlp downloads nothing the second time, and the result must
  // be identical rather than empty.
  for (let i = 0; i < 2; i++) {
    catalog.load(dir, COURSE);
    catalog.registerTree(path.join(dir, "VIDEOS"), {
      category: "VIDEOS",
      kind: "video",
      sourceUrl: "https://mitsloan.hosted.panopto.com/folder/1",
    });
    catalog.reconcile(new Set(["VIDEOS"]));
    catalog.save();
    catalog.reset();
  }

  const items = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.title).sort(), ["Lecture 1", "Lecture 2"]);
  assert.equal(items[0].section, "Lectures", "the playlist folder becomes the section");
  assert.equal(items[0].state, "present", "a resumed run must not flag them removed");
});

test("applyDates enriches by normalized url and leaves misses alone", () => {
  const dir = tmpCourse();
  catalog.load(dir, COURSE);
  recordItem(dir, ASSIGN_A, "ASSIGNMENT.pdf");
  recordItem(dir, MODULE_A);
  catalog.applyDates(
    new Map([[catalog.key(ASSIGN_A.url), { due_at: "2026-10-04T03:59:00Z", points_possible: 20 }]])
  );
  catalog.save();
  catalog.reset();

  const items = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE))).items;
  const assign = items.find((i) => i.category === "ASSIGNMENTS");
  const mod = items.find((i) => i.category === "MODULES");
  assert.equal(assign.due_at, "2026-10-04T03:59:00Z");
  assert.equal(assign.points_possible, 20);
  assert.equal(mod.due_at, null);
});

test("a disabled catalog records nothing and never throws", () => {
  const dir = tmpCourse();
  catalog.reset();
  assert.equal(catalog.beginItem(MODULE_A), null);
  catalog.noteDir(dir);
  catalog.file(path.join(dir, "nope.pdf"));
  catalog.endItem(1);
  catalog.save();
  assert.equal(fs.existsSync(path.join(dir, CATALOG_FILE)), false);
});
