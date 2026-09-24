import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { readGaps, saveDropped, removeDropped, readDryRun, dropDir } from "../web/gaps.js";

function archive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gaps-test-"));
  fs.writeFileSync(
    path.join(root, "report-skipped.csv"),
    'url,reason,dest_dir,course_name,course_url\r\n' +
      '"https://canvas.x.edu/courses/1/external_tools/retrieve?url=hbsp","LTI launch yielded no file","/a/ASSIGNMENTS/Wk 1/Case/ASSIGNMENT","15.722","https://canvas.x.edu/courses/1"\r\n' +
      '"https://www.nytimes.com/2026/01/01/a.html","paywalled article — login/subscription-gated","","15.722","https://canvas.x.edu/courses/1"\r\n' +
      '"https://www.jstor.org/stable/1","library-licensed resource — a catalog link","","15.722","https://canvas.x.edu/courses/1"\r\n'
  );
  return root;
}

test("gaps separate what a dropped file can fix from what it cannot", () => {
  // A paywall or a licensed database reader has no file to save, so offering
  // to import one is a waste of the user's time. An LTI launch is exactly the
  // case this screen exists for.
  const g = readGaps(archive());
  assert.equal(g.gaps.length, 3);
  const byLabel = Object.fromEntries(g.gaps.map((x) => [x.url, x]));
  assert.equal(
    byLabel["https://canvas.x.edu/courses/1/external_tools/retrieve?url=hbsp"].recoverable,
    true
  );
  assert.equal(byLabel["https://www.nytimes.com/2026/01/01/a.html"].recoverable, false);
  assert.equal(byLabel["https://www.jstor.org/stable/1"].recoverable, false);
});

test("a gap is labelled by its item, not its URL", () => {
  const g = readGaps(archive());
  const lti = g.gaps.find((x) => x.destDir);
  assert.equal(lti.label, "Case", "the item folder is the human-readable name");
});

test("an archive with no skipped report reports no gaps rather than failing", () => {
  const g = readGaps(fs.mkdtempSync(path.join(os.tmpdir(), "gaps-empty-")));
  assert.deepEqual(g.gaps, []);
  assert.equal(g.error, undefined);
});

test("an uploaded name cannot escape the drop folder", () => {
  // The name comes from a browser file picker and is attacker-influenced in
  // the general case, so only the basename is ever used.
  const root = archive();
  const saved = saveDropped(root, "../../escape.pdf", Buffer.from("x"));
  assert.equal(path.dirname(saved.path), dropDir(root));
  assert.equal(saved.name, "escape.pdf");
  assert.ok(!fs.existsSync(path.join(root, "..", "escape.pdf")));

  for (const bad of ["", "   ", "..", ".hidden"]) {
    assert.throws(() => saveDropped(root, bad, Buffer.from("x")), /bad file name/);
  }
});

test("a dropped file round-trips and can be removed", () => {
  const root = archive();
  saveDropped(root, "reading.pdf", Buffer.from("hello"));
  assert.deepEqual(readGaps(root).dropped, ["reading.pdf"]);
  removeDropped(root, "reading.pdf");
  assert.deepEqual(readGaps(root).dropped, []);
});

test("the dry-run report is parsed, counted and reported as absent when missing", () => {
  const root = archive();
  assert.equal(readDryRun(root).exists, false);

  fs.writeFileSync(
    path.join(root, "dry-run-report.csv"),
    "status,kind,url,reason,course_name,course_url\r\n" +
      "accessible,file,https://a/1,,15.722,https://canvas.x.edu/courses/1\r\n" +
      "inaccessible,artifact,https://a/2,HTTP 403,15.722,https://canvas.x.edu/courses/1\r\n" +
      "accessible,page,https://a/3,,15.722,https://canvas.x.edu/courses/1\r\n"
  );
  const d = readDryRun(root);
  assert.equal(d.exists, true);
  assert.equal(d.rows.length, 3);
  assert.equal(d.accessible, 2);
  assert.equal(d.inaccessible, 1);
  assert.equal(d.rows[1].reason, "HTTP 403");
  assert.ok(d.updated, "an mtime is reported so the UI can say how stale it is");
});
