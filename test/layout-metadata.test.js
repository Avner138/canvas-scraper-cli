import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import wiki from "../scrapers/wiki.js";
import octarine from "../scrapers/octarine.js";

function scrapeOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-meta-test-"));
  const course = path.join(dir, "MyCourse");
  fs.mkdirSync(path.join(course, "ASSIGNMENTS", "HW"), { recursive: true });
  fs.writeFileSync(path.join(course, "ASSIGNMENTS", "HW", "reading.pdf"), "pdf");
  // Resume bookkeeping that must never be treated as course material.
  fs.writeFileSync(path.join(course, ".scrape-manifest.json"), '{"version":1}');
  fs.writeFileSync(path.join(course, ".yt-dlp-archive.txt"), "youtube abc123");
  // An interrupted download left a .part file behind.
  fs.writeFileSync(path.join(course, "ASSIGNMENTS", "HW", "big.pdf.part"), "half");
  return dir;
}

test("wiki does not catalog the resume manifest, yt-dlp archive, or .part files", () => {
  const dir = scrapeOutput();
  const { sources } = wiki.build(dir);

  assert.equal(sources, 1, "only reading.pdf is a source");
  const index = fs.readFileSync(path.join(dir, "index.md"), "utf8");
  assert.ok(!index.includes(".scrape-manifest"), "manifest not in index");
  assert.ok(!index.includes(".yt-dlp-archive"), "archive not in index");
  assert.ok(!index.includes(".part"), ".part not in index");
  assert.ok(index.includes("reading.pdf"), "real source is in index");

  // The dotfiles still travel with the course folder into raw/ (they aren't
  // course material, but the sweep moves the whole folder), so resume metadata
  // isn't destroyed — just not cataloged.
  assert.ok(fs.existsSync(path.join(dir, "raw", "MyCourse", ".scrape-manifest.json")));
});

test("octarine does not catalog the resume manifest, yt-dlp archive, or .part files", () => {
  const dir = scrapeOutput();
  const { sources } = octarine.build(dir, [{ courseName: "MyCourse" }]);

  assert.equal(sources, 1, "only reading.pdf is a source");
  const files = fs.readdirSync(dir);
  const indexName = files.find((f) => f.toLowerCase() === "index.md");
  const index = fs.readFileSync(path.join(dir, indexName), "utf8");
  assert.ok(!index.includes(".scrape-manifest"));
  assert.ok(!index.includes(".yt-dlp-archive"));
});

/**
 * The category taxonomy was dead for the life of the project: KNOWN_CATEGORIES
 * is lowercase while every scraper writes UPPERCASE folders, so classify() and
 * categoryOf() never matched and everything landed under a single "Other"
 * heading. The existing tests above missed it because they assert on source
 * counts and dotfile exclusion, never on the headings — which is how wiki.js
 * sat at 96% line coverage with a broken taxonomy.
 */
test("wiki files uppercase category folders under their real headings", () => {
  const dir = scrapeOutput();
  fs.mkdirSync(path.join(dir, "MyCourse", "MODULES", "Week 1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "MyCourse", "MODULES", "Week 1", "slides.pdf"), "pdf");
  fs.writeFileSync(path.join(dir, "MyCourse", "HOMEPAGE.pdf"), "pdf");

  wiki.build(dir);
  const index = fs.readFileSync(path.join(dir, "index.md"), "utf8");

  assert.ok(index.includes("### Assignments"), "ASSIGNMENTS reaches its heading");
  assert.ok(index.includes("### Modules"), "MODULES reaches its heading");
  assert.ok(index.includes("### Overview"), "a course-root file is Overview");
  assert.ok(!index.includes("### Other"), "nothing falls through to Other");
});

test("octarine files uppercase category folders under their real headings", () => {
  const dir = scrapeOutput();
  fs.mkdirSync(path.join(dir, "MyCourse", "QUIZZES", "Quiz 1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "MyCourse", "QUIZZES", "Quiz 1", "quiz.pdf"), "pdf");

  octarine.build(dir);
  const note = fs.readFileSync(path.join(dir, "Courses", "MyCourse.md"), "utf8");

  assert.ok(note.includes("## Assignments"), "ASSIGNMENTS reaches its heading");
  assert.ok(note.includes("## Quizzes"), "QUIZZES reaches its heading");
  assert.ok(!note.includes("## Other"), "nothing falls through to Other");
});

/**
 * The study plan is the user's own state and lives at the archive root. Both
 * sweeps enumerate with readdirSync, which includes dotfiles, so without an
 * explicit reservation the first --wiki run would move it into raw/ and the
 * app would silently create a fresh empty one — losing every completed task.
 */
test("the study plan is never swept into a reorganized layout", () => {
  for (const [name, build, subdir] of [
    ["wiki", wiki.build, "raw"],
    ["octarine", octarine.build, ".attachments"],
  ]) {
    const dir = scrapeOutput();
    const plan = path.join(dir, ".study-plan.json");
    fs.writeFileSync(plan, '{"version":1,"entries":{"x":{"done":true}}}');

    build(dir);

    assert.ok(fs.existsSync(plan), `${name}: the plan stays at the archive root`);
    assert.ok(
      !fs.existsSync(path.join(dir, subdir, ".study-plan.json")),
      `${name}: the plan was not moved into ${subdir}/`
    );
    assert.equal(
      JSON.parse(fs.readFileSync(plan, "utf8")).entries.x.done,
      true,
      `${name}: its contents are untouched`
    );
  }
});

/** The per-course catalog travels with the course folder but is not a source. */
test("the item catalog rides along into raw/ without being cataloged", () => {
  const dir = scrapeOutput();
  fs.writeFileSync(
    path.join(dir, "MyCourse", ".scrape-catalog.json"),
    '{"version":1,"items":[]}'
  );

  const { sources } = wiki.build(dir);

  assert.equal(sources, 1, "the catalog is not counted as course material");
  assert.ok(
    fs.existsSync(path.join(dir, "raw", "MyCourse", ".scrape-catalog.json")),
    "but it moves with the course folder, so the index stays readable"
  );
});
