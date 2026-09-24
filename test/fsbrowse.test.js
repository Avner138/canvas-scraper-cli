import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { validate, listDir, suggestions } from "../web/fsbrowse.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fsbrowse-test-"));
}

test("an empty path is refused rather than silently meaning the cwd", () => {
  // path.resolve("") returns the working directory, so without an explicit
  // guard an empty box validates clean and the app adopts whatever folder it
  // was launched from — which is never what the user meant.
  for (const value of ["", "   ", null, undefined]) {
    const v = validate(value);
    assert.equal(v.ok, false, `${JSON.stringify(value)} must not validate`);
    assert.match(v.error, /enter a folder/);
  }
});

test("a folder that does not exist yet is usable, and says so", () => {
  const root = tmp();
  const target = path.join(root, "new", "deeper", "archive");
  const v = validate(target);
  assert.equal(v.ok, true, "the scraper creates it, so this is fine");
  assert.equal(v.exists, false);
  assert.equal(v.willCreate, true);
  assert.equal(v.writable, true, "writability comes from the nearest real ancestor");
});

test("an existing archive is recognized by its course manifests", () => {
  const root = tmp();
  const course = path.join(root, "Some Course");
  fs.mkdirSync(course, { recursive: true });
  fs.writeFileSync(path.join(course, ".scrape-manifest.json"), "{}");

  const v = validate(root);
  assert.equal(v.ok, true);
  assert.equal(v.hasCourses, true);
  assert.equal(v.isEmpty, false);
});

test("an empty folder is usable and reported as empty", () => {
  const v = validate(tmp());
  assert.equal(v.ok, true);
  assert.equal(v.isEmpty, true);
  assert.equal(v.hasCourses, false);
});

test("an unwritable destination is refused with the reason", () => {
  const v = validate("/System/Library/canvas-scraper-should-not-be-here");
  assert.equal(v.ok, false);
  assert.match(v.error, /not writable/);
});

test("listDir returns subdirectory names only, and never files", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, "alpha"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "notes.txt"), "x");

  const d = listDir(root);
  assert.deepEqual(d.dirs, ["alpha", "beta"], "sorted, no files, no dotfolders");
  assert.equal(d.exists, true);
  assert.ok(d.parent, "a parent is offered for navigating up");
});

test("listDir on a missing path reports it rather than throwing", () => {
  const d = listDir(path.join(tmp(), "nope"));
  assert.equal(d.exists, false);
  assert.deepEqual(d.dirs, []);
});

test("suggestions put recents first and never repeat a folder", () => {
  const root = tmp();
  const list = suggestions([root, root, null, "/definitely/not/here"]);
  assert.equal(list[0].path, root, "a recent archive leads");
  assert.equal(list[0].kind, "recent");
  assert.equal(
    list.filter((s) => s.path === root).length,
    1,
    "a duplicate recent appears once"
  );
  assert.ok(
    !list.some((s) => s.path === "/definitely/not/here"),
    "a folder that no longer exists is dropped"
  );
  assert.ok(list.every((s) => typeof s.writable === "boolean"));
});
