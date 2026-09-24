import { api, el, ago, openUrl } from "../lib/api.js";

/**
 * Dry run — the accessibility probe, as a table rather than a CSV.
 *
 * A dry run answers "what would a real scrape actually get?" without
 * downloading anything, which is the question worth asking the day before
 * cookies expire or right after a course is archived. The scraper already
 * writes the answer; this just makes it readable.
 */

let FILTER = "inaccessible";
let SEARCH = "";

export async function renderDryRun() {
  const state = await api("/api/state");
  const root = state.settings?.defaultRoot || state.roots?.[0] || "courses";
  const data = await api(`/api/dry-run?root=${encodeURIComponent(root)}`);

  const wrap = el("div");
  wrap.append(
    el("h1", {}, "Dry run"),
    el(
      "p.sub",
      {},
      "Every article and artifact probed for reachability, downloading nothing. Worth running before a long scrape, or when you suspect a session has expired."
    )
  );

  if (!data.exists) {
    wrap.append(
      el(
        "div.banner.warn",
        {},
        "No dry-run report in this archive yet. Start one from the Run screen — it downloads nothing."
      )
    );
    return wrap;
  }
  if (data.error) {
    wrap.append(el("div.banner.bad", {}, data.error));
    return wrap;
  }

  wrap.append(
    el(
      "dl.strip",
      {},
      el("div", {}, el("dt", {}, "Probed"), el("dd", {}, String(data.rows.length))),
      el("div", {}, el("dt", {}, "Reachable"), el("dd", {}, String(data.accessible))),
      el(
        "div",
        {},
        el("dt", {}, "Blocked"),
        el("dd", { class: data.inaccessible ? "is-warn" : "" }, String(data.inaccessible))
      ),
      el("div", {}, el("dt", {}, "Run"), el("dd", {}, ago(data.updated)))
    )
  );

  const search = el("input", {
    type: "text",
    value: SEARCH,
    placeholder: "filter by url, reason or course",
    "aria-label": "Filter",
    onInput: (e) => {
      SEARCH = e.target.value;
      window.__refresh();
    },
  });
  const tabs = el("div.toolbar", {});
  for (const [key, label] of [
    ["inaccessible", "Blocked"],
    ["accessible", "Reachable"],
    ["all", "Everything"],
  ]) {
    tabs.append(
      el(
        `button.btn.sm${FILTER === key ? ".primary" : ""}`,
        {
          onClick: () => {
            FILTER = key;
            window.__refresh();
          },
        },
        label
      )
    );
  }
  tabs.append(el("span.spacer"), search);
  wrap.append(tabs);

  const needle = SEARCH.trim().toLowerCase();
  let rows = data.rows.filter((r) => FILTER === "all" || r.status === FILTER);
  if (needle) {
    rows = rows.filter((r) =>
      `${r.url} ${r.reason} ${r.courseName} ${r.kind}`.toLowerCase().includes(needle)
    );
  }

  if (!rows.length) {
    // "Nothing matches that filter" buries the actual news when the filter is
    // Blocked and the answer is that nothing was.
    const clean = FILTER === "inaccessible" && !needle && !data.inaccessible;
    wrap.append(
      el(
        "div.banner.ok",
        {},
        clean
          ? "Nothing was blocked — every item probed cleanly."
          : "Nothing matches that filter."
      )
    );
    return wrap;
  }

  // Capped, because a full probe is hundreds of rows and nobody reads past the
  // first screen of them — the filter is the tool for finding a specific one.
  const shown = rows.slice(0, 300);
  const table = el(
    "table",
    {},
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, "Status"),
        el("th", {}, "Kind"),
        el("th", {}, "URL"),
        el("th", {}, "Reason"),
        el("th", {}, "Course"),
        el("th", {}, "")
      )
    ),
    el(
      "tbody",
      {},
      shown.map((r) =>
        el(
          `tr.sev-${r.status === "accessible" ? "ok" : "warn"}`,
          {},
          el(
            "td.stripe",
            {},
            r.status === "accessible"
              ? el("span.badge.ok", {}, "ok")
              : el("span.badge.warn", {}, "blocked")
          ),
          el("td.meta", {}, r.kind || "—"),
          el("td.path", {}, r.url),
          el("td.meta", {}, r.reason || "—"),
          el("td.meta", {}, r.courseName),
          el(
            "td.nowrap",
            {},
            /^https?:/.test(r.url)
              ? el("button.btn.sm", { onClick: () => openUrl(r.url) }, "Open ↗")
              : null
          )
        )
      )
    )
  );
  wrap.append(el("div.tablewrap", {}, table));
  if (rows.length > shown.length) {
    wrap.append(
      el("p.note", {}, `Showing ${shown.length} of ${rows.length} — narrow with the filter.`)
    );
  }
  return wrap;
}
