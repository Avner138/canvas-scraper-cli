import { api, el, bytes, toast } from "./api.js";

/**
 * The folder picker.
 *
 * Served from the app rather than the browser's own dialog: the File System
 * Access API is Chromium-only and, more to the point, hands back a handle
 * whose absolute path cannot be read — while the scraper needs a real path.
 * Doing it here also means Safari and Firefox behave identically.
 *
 * Three ways in, because people arrive differently: the shortcuts rail for the
 * obvious places, the directory browser for poking around, and the path box
 * for pasting something you already know.
 */

/** A short free-space note, or nothing when the platform didn't say. */
function freeNote(n) {
  return n === null || n === undefined ? "" : `${bytes(n)} free`;
}

/**
 * Opens the picker.
 * @param {object} opts
 * @param {string} opts.current the folder in use now
 * @param {(path: string) => void} opts.onChoose called after the app accepts it
 */
export async function openPicker({ current, onChoose }) {
  const overlay = el("div.overlay", {});
  const box = el("div.picker", { role: "dialog", "aria-modal": "true", "aria-label": "Choose a folder" });
  overlay.append(box);

  let cwd = current || "";
  const pathInput = el("input.pathbox", {
    type: "text",
    value: current || "",
    spellcheck: "false",
    "aria-label": "Folder path",
  });
  const status = el("div.pickerstatus", {});
  const listBox = el("div.dirlist", {});
  const crumbs = el("div.crumbs", {});
  const makeDefault = el("input", { type: "checkbox", id: "mkdefault", checked: true });

  const close = () => overlay.remove();

  /** Re-validates whatever is in the path box and updates the footer. */
  const check = async () => {
    const value = pathInput.value.trim();
    if (!value) {
      status.replaceChildren(el("span.muted", {}, "Enter or choose a folder."));
      useBtn.disabled = true;
      return;
    }
    try {
      const v = await api("/api/fs/validate", {
        method: "POST",
        body: JSON.stringify({ path: value }),
      });
      status.replaceChildren();
      if (!v.ok) {
        status.append(el("span.is-bad", {}, v.error || "unusable"));
        useBtn.disabled = true;
        return;
      }
      const bits = [];
      if (v.willCreate) bits.push("will be created");
      else if (v.hasCourses) bits.push("contains scraped courses");
      else if (v.isEmpty) bits.push("empty");
      if (v.freeBytes != null) bits.push(freeNote(v.freeBytes));
      status.append(el("span.muted", {}, bits.join(" · ")));
      for (const w of v.warnings || []) {
        status.append(el("div.is-warn.meta", {}, w));
      }
      useBtn.disabled = false;
    } catch (e) {
      status.replaceChildren(el("span.is-bad", {}, e.message));
      useBtn.disabled = true;
    }
  };

  /** Loads a directory into the browser pane. */
  const browse = async (target) => {
    try {
      const d = await api(`/api/fs/list?path=${encodeURIComponent(target)}`);
      cwd = d.path;
      pathInput.value = d.path;
      crumbs.replaceChildren();
      if (d.parent) {
        crumbs.append(
          el("button.btn.sm", { onClick: () => browse(d.parent) }, "↑ Up")
        );
      }
      crumbs.append(el("span.path", {}, d.path));
      listBox.replaceChildren();
      if (d.error) {
        listBox.append(el("div.muted.pad", {}, d.error));
      } else if (!d.dirs.length) {
        listBox.append(el("div.muted.pad", {}, "No subfolders here."));
      } else {
        for (const name of d.dirs) {
          listBox.append(
            el(
              "button.diritem",
              { onClick: () => browse(`${d.path}/${name}`) },
              el("span.folder", {}, "📁"),
              name
            )
          );
        }
      }
      check();
    } catch (e) {
      toast(`Could not open that folder: ${e.message}`);
    }
  };

  const useBtn = el(
    "button.btn.primary",
    {
      onClick: async () => {
        try {
          const r = await api("/api/fs/use", {
            method: "POST",
            body: JSON.stringify({
              path: pathInput.value.trim(),
              makeDefault: makeDefault.checked,
            }),
          });
          close();
          toast(`Using ${r.path}`);
          onChoose(r.path);
        } catch (e) {
          toast(`Could not use that folder: ${e.message}`);
        }
      },
    },
    "Use this folder"
  );

  // Shortcuts rail
  const rail = el("div.shortcuts", {});
  try {
    const { suggestions } = await api("/api/fs/suggestions");
    for (const s of suggestions) {
      rail.append(
        el(
          "button.shortcut",
          { onClick: () => browse(s.path), title: s.path },
          el("span.shortcutlabel", {}, s.label),
          el("span.meta.muted", {}, s.kind === "cloud" ? "cloud sync" : freeNote(s.freeBytes))
        )
      );
    }
  } catch (e) {
    rail.append(el("div.muted.meta", {}, "Could not read suggestions."));
  }

  pathInput.addEventListener("input", () => check());
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !useBtn.disabled) useBtn.click();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && document.body.contains(overlay)) close();
    },
    { once: true }
  );

  box.append(
    el("h2", {}, "Choose a folder"),
    el(
      "p.sub",
      {},
      "Where courses are downloaded and where this archive's plan is kept. A folder that doesn't exist yet is fine — it will be created."
    ),
    el("div.pickerbody", {}, rail, el("div.browser", {}, crumbs, listBox)),
    el("div.toolbar", {}, pathInput),
    status,
    el(
      "div.toolbar",
      {},
      el("label.muted.meta", {}, makeDefault, " remember as my default"),
      el("span.spacer"),
      el("button.btn", { onClick: close }, "Cancel"),
      useBtn
    )
  );

  document.body.append(overlay);
  await browse(current || "");
  pathInput.focus();
}
