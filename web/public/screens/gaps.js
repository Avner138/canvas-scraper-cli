import { api, el, bytes, openUrl, toast } from "../lib/api.js";

/**
 * Gaps — the things the scraper could not get, and a way to close them.
 *
 * On the command line this is: read report-skipped.csv, find the dest_dir,
 * open the link by hand, save the file, write a mapping manifest, run the
 * importer. Here it is open, drop, match, import. That chore is the reason
 * core/import.js exists, and it is the clearest thing a GUI can improve.
 */

/** Matches a dropped file to a gap; survives re-renders within a visit. */
let MATCHES = new Map();

function severity(g) {
  if (g.imported) return "ok";
  return g.recoverable ? "warn" : "ghost";
}

export async function renderGaps() {
  const state = await api("/api/state");
  const root = state.settings?.defaultRoot || state.roots?.[0] || "courses";
  const data = await api(`/api/gaps?root=${encodeURIComponent(root)}`);
  const refresh = () => window.__refresh();

  const wrap = el("div");
  wrap.append(
    el("h1", {}, "Gaps"),
    el(
      "p.sub",
      {},
      "Items the scraper could not download. Open one, save the file yourself, drop it here, and it is filed into the exact folder the scrape would have used."
    )
  );

  if (data.error) {
    wrap.append(el("div.banner.bad", {}, data.error));
    return wrap;
  }
  if (!data.gaps.length) {
    wrap.append(
      el(
        "div.banner.ok",
        {},
        "No gaps recorded. Either everything downloaded, or this archive has no report-skipped.csv yet — run a scrape with CSV reports enabled."
      )
    );
    return wrap;
  }

  const open = data.gaps.filter((g) => !g.imported);
  const recoverable = open.filter((g) => g.recoverable);
  wrap.append(
    el(
      "dl.strip",
      {},
      el("div", {}, el("dt", {}, "Gaps"), el("dd", {}, String(data.gaps.length))),
      el(
        "div",
        {},
        el("dt", {}, "Open"),
        el("dd", { class: open.length ? "is-warn" : "" }, String(open.length))
      ),
      el("div", {}, el("dt", {}, "Fixable by hand"), el("dd", {}, String(recoverable.length))),
      el("div", {}, el("dt", {}, "Imported"), el("dd", {}, String(data.imported)))
    )
  );

  wrap.append(dropZone(data, root, refresh));
  wrap.append(gapTable(data, root, refresh));

  wrap.append(
    el(
      "p.note",
      {},
      el("b", {}, "Not every gap is fixable. "),
      "A paywalled article or a library-licensed database reader has no file to save — those are marked and left alone. The ones worth your time are the LTI launches and the locked files."
    )
  );
  return wrap;
}

/** Upload area plus the list of files waiting to be matched. */
function dropZone(data, root, refresh) {
  const box = el("div.panel.section", {});
  const fileInput = el("input", {
    type: "file",
    multiple: true,
    id: "dropfiles",
    onChange: (e) => upload([...e.target.files]),
  });

  const upload = async (files) => {
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        await api(
          `/api/gaps/file?root=${encodeURIComponent(root)}&name=${encodeURIComponent(f.name)}`,
          { method: "PUT", body: buf, headers: { "Content-Type": "application/octet-stream" } }
        );
        toast(`Added ${f.name}`);
      } catch (err) {
        toast(`${f.name}: ${err.message}`);
      }
    }
    refresh();
  };

  const zone = el(
    "div.drop",
    {
      onDragover: (e) => {
        e.preventDefault();
        zone.classList.add("over");
      },
      onDragleave: () => zone.classList.remove("over"),
      onDrop: (e) => {
        e.preventDefault();
        zone.classList.remove("over");
        upload([...(e.dataTransfer?.files || [])]);
      },
    },
    el("strong", {}, "Drop files here"),
    el("span.meta.muted", {}, "or "),
    el("label.linklike.inline", { for: "dropfiles" }, "choose files"),
    fileInput
  );

  box.append(el("h3", {}, "Files to file"), zone);

  if (data.dropped.length) {
    const list = el("div.droplist", {});
    for (const name of data.dropped) {
      const match = MATCHES.get(name) || "";
      const select = el("select.sel", {
        onChange: (e) => {
          if (e.target.value) MATCHES.set(name, e.target.value);
          else MATCHES.delete(name);
          updateButton();
        },
      });
      select.append(el("option", { value: "" }, "— match to a gap —"));
      for (const g of data.gaps.filter((x) => !x.imported)) {
        select.append(
          el("option", { value: g.url, selected: match === g.url }, `${g.label} · ${g.courseName}`)
        );
      }
      list.append(
        el(
          "div.droprow",
          {},
          el("span.path", {}, name),
          select,
          el(
            "button.btn.sm",
            {
              onClick: async () => {
                await api(
                  `/api/gaps/file?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`,
                  { method: "DELETE" }
                ).catch((e) => toast(e.message));
                MATCHES.delete(name);
                refresh();
              },
            },
            "Remove"
          )
        )
      );
    }
    box.append(list);

    const importBtn = el(
      "button.btn.primary",
      {
        onClick: async () => {
          const mappings = [...MATCHES.entries()].map(([file, url]) => ({ file, url }));
          try {
            const r = await api("/api/gaps/import", {
              method: "POST",
              body: JSON.stringify({ root, mappings }),
            });
            toast(`Imported ${mappings.length} file(s)`);
            MATCHES = new Map();
            refresh();
            return r;
          } catch (e) {
            toast(`Import failed: ${e.message}`);
          }
        },
      },
      "Import matched files"
    );
    const updateButton = () => {
      importBtn.disabled = MATCHES.size === 0;
      importBtn.textContent = MATCHES.size
        ? `Import ${MATCHES.size} matched file(s)`
        : "Import matched files";
    };
    updateButton();
    box.append(el("div.toolbar", {}, importBtn));
  }
  return box;
}

function gapTable(data, root, refresh) {
  const rows = data.gaps.map((g) =>
    el(
      `tr.sev-${severity(g)}`,
      {},
      el(
        "td.stripe",
        {},
        el("span.coursename", {}, g.label),
        el("span.path.sub-line.clamp2", { title: g.url }, g.url)
      ),
      el(
        "td",
        {},
        el("span.meta.clamp2", { title: g.reason }, g.reason),
        g.destDir ? el("span.path.sub-line.clamp2", { title: g.destDir }, g.destDir) : null
      ),
      el("td", {}, g.courseName),
      el(
        "td",
        {},
        g.imported
          ? el("span.badge.ok", {}, "imported")
          : g.recoverable
            ? el("span.badge.warn", {}, "open")
            : el("span.badge.ghost", {}, "not fixable")
      ),
      el(
        "td.nowrap",
        {},
        g.recoverable && !g.imported
          ? el("button.btn.sm", { onClick: () => openUrl(g.url) }, "Open ↗")
          : null
      )
    )
  );

  return el(
    "div.tablewrap.section",
    {},
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Item"),
          el("th", {}, "Why it failed"),
          el("th", {}, "Course"),
          el("th", {}, "State"),
          el("th", {}, "")
        )
      ),
      el("tbody", {}, rows)
    )
  );
}
