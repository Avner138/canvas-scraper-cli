import { api, el, bytes, ago, openPath, openUrl, toast } from "../lib/api.js";
import { openPicker } from "../lib/picker.js";

/**
 * Library — the archive as an inventory rather than a folder tree.
 *
 * Everything shown is read back from the per-course manifest, so the four
 * states mean exactly what the scraper means by them. "Flagged" in particular
 * is not an error: the source went from the course, and the local copy was
 * deliberately kept.
 */

/** Which severity stripe a course row gets, worst-first. */
function severity(c) {
  if (c.missing) return "bad";
  if (c.incomplete || (c.filesOnDisk && !c.assets)) return "warn";
  if (c.removed) return "ghost";
  return "ok";
}

/**
 * The one-line health verdict for a course, worst thing first.
 *
 * "Empty" means no files at all. A folder full of files that the manifest has
 * no entry for is not empty — it is untracked, which is a different problem
 * and has a different fix.
 */
function healthBadge(c) {
  if (!c.filesOnDisk) return el("span.badge.idle", {}, "empty");
  if (c.missing) return el("span.badge.bad", {}, `${c.missing} missing`);
  if (c.incomplete) return el("span.badge.warn", {}, `${c.incomplete} incomplete`);
  if (!c.assets) return el("span.badge.warn", {}, "untracked");
  if (c.removed) return el("span.badge.ghost", {}, `${c.removed} flagged`);
  return el("span.badge.ok", {}, "complete");
}

function courseRow(c) {
  const actions = el("td.nowrap");
  actions.append(
    el("button.btn.sm", { onClick: () => openPath(c.dir) }, "Open folder")
  );
  if (c.hasHomepage) {
    actions.append(
      " ",
      el(
        "button.btn.sm",
        { onClick: () => openPath(`${c.dir}/HOMEPAGE.pdf`) },
        "Homepage"
      )
    );
  }
  if (c.url) {
    actions.append(" ", el("button.btn.sm", { onClick: () => openUrl(c.url) }, "Canvas ↗"));
  }

  return el(
    `tr.sev-${severity(c)}`,
    {},
    el(
      "td.stripe",
      {},
      el("span.coursename", {}, c.name),
      el("span.path.sub-line", {}, c.dir)
    ),
    el(
      "td.num",
      {},
      c.indexed ? String(c.itemCount) : el("span.muted", {}, "—")
    ),
    el(
      "td.num",
      {},
      String(c.filesOnDisk),
      c.untracked
        ? el("span.path.sub-line.is-warn", {}, `${c.untracked} untracked`)
        : null
    ),
    el("td.num", {}, bytes(c.bytesOnDisk)),
    el("td.num", {}, ago(c.updated)),
    el("td", {}, healthBadge(c)),
    actions
  );
}

export async function renderLibrary() {
  const state = await api("/api/state");
  const root = state.settings?.defaultRoot || state.roots?.[0] || "courses";
  const lib = await api(`/api/library?root=${encodeURIComponent(root)}`);

  const wrap = el("div");
  wrap.append(
    el("h1", {}, "Library"),
    el(
      "p.sub",
      {},
      "Everything on disk, read back from each course's manifest. This is the view the CLI can't give you — it thinks in runs, not in a collection you own."
    )
  );

  // Chrome is needed for every scrape, so a missing one is worth saying here
  // rather than at the moment a run fails.
  if (!state.chrome?.found) {
    const b = el("div.banner.warn", {}, "Google Chrome was not found — scraping needs it.");
    if (state.chrome?.instructions) b.append(el("pre", {}, state.chrome.instructions));
    wrap.append(b);
  }

  wrap.append(
    el(
      "div.toolbar",
      {},
      el("span.muted", {}, "Archive"),
      el("span.path", {}, lib.root),
      el(
        "button.btn.sm",
        {
          onClick: () =>
            openPicker({ current: lib.root, onChoose: () => window.__refresh() }),
        },
        "Change…"
      ),
      el("span.spacer"),
      el("span.badge.idle", {}, `layout: ${lib.layout}`)
    )
  );

  if (!lib.exists) {
    wrap.append(
      el(
        "div.banner.warn",
        {},
        `No folder at ${lib.root}. Point this at the directory you scraped into.`
      )
    );
    return wrap;
  }

  const t = lib.totals;
  wrap.append(
    el(
      "dl.strip",
      {},
      el("div", {}, el("dt", {}, "Courses"), el("dd", {}, String(t.courses))),
      el("div", {}, el("dt", {}, "Files"), el("dd", {}, String(t.filesOnDisk))),
      el("div", {}, el("dt", {}, "On disk"), el("dd", {}, t.bytesOnDiskHuman)),
      el(
        "div",
        {},
        el("dt", {}, "Untracked"),
        el("dd", { class: t.untracked ? "is-warn" : "" }, String(t.untracked))
      ),
      el(
        "div",
        {},
        el("dt", {}, "Incomplete"),
        el("dd", { class: t.incomplete ? "is-warn" : "" }, String(t.incomplete))
      ),
      el(
        "div",
        {},
        el("dt", {}, "Missing"),
        el("dd", { class: t.missing ? "is-bad" : "" }, String(t.missing))
      ),
      el(
        "div",
        {},
        el("dt", {}, "Flagged"),
        el("dd", { class: t.removed ? "is-ghost" : "" }, String(t.removed))
      )
    )
  );

  if (!lib.courses.length) {
    wrap.append(
      el(
        "div.banner.warn",
        {},
        "No courses here yet. A course folder is one containing a .scrape-manifest.json — run a scrape into this folder first."
      )
    );
    return wrap;
  }

  const table = el(
    "table",
    {},
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, "Course"),
        el("th", {}, "Items"),
        el("th", {}, "Files"),
        el("th", {}, "Size"),
        el("th", {}, "Scraped"),
        el("th", {}, "State"),
        el("th", {}, "")
      )
    ),
    el("tbody", {}, lib.courses.map(courseRow))
  );
  wrap.append(el("div.tablewrap", {}, table));

  if (lib.courses.some((c) => !c.indexed)) {
    wrap.append(
      el(
        "p.note",
        {},
        el("b", {}, "Items shows “—” for courses scraped before the catalog existed. "),
        "Re-scrape a course to index it; the download itself is skipped for anything already complete."
      )
    );
  }

  if (t.untracked) {
    wrap.append(
      el(
        "p.note",
        {},
        el("b", {}, `${t.untracked} file(s) on disk have no manifest entry. `),
        "Several download paths — Study.Net materials, the page PDFs, webpage archives and videos — are written without one. ",
        "Nothing is wrong with the files, but a re-run has no way to know they exist, so it downloads them again. ",
        "Indexing them is what the item catalog is for."
      )
    );
  }

  wrap.append(
    el(
      "p.note",
      {},
      el("b", {}, "Flagged is not an error. "),
      "It means the source went from the course but your copy is intact. ",
      "Missing is the one to look at: the manifest says complete but the file isn't on disk, which is what a cloud-sync placeholder looks like — and it makes the next run re-download."
    )
  );

  if (lib.reports.errorsUpdated) {
    wrap.append(
      el(
        "p.note",
        {},
        `errors.csv holds ${lib.reports.errors} row(s), last written ${ago(lib.reports.errorsUpdated)}. `,
        "A clean run doesn't overwrite it, so it may describe an older failure."
      )
    );
  }

  return wrap;
}
