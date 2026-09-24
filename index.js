import fs from "fs";
import { Command } from "commander";
import inquirer from "inquirer";

import helpers from "./scrapers/helpers.js";
import { runScrape } from "./core/scrape.js";
import { runLogin } from "./core/login.js";
import { runImport } from "./core/import.js";
import { renderTui } from "./tui/app.js";
import { ensureChrome } from "./core/chrome.js";

const argDef = [
  {
    type: "input",
    name: "[url]",
    message:
      "Enter a Course URL (https://<school_domain>/courses/<course_id>) or just the domain (https://<school_domain>) to scrape all your courses:",
    validate: (input) =>
      /^https:\/\/[^/]+(\/courses\/[^/]+)?\/?$/.test(input) ||
      "Invalid URL. Use https://<school_domain> (all courses) or https://<school_domain>/courses/<course_id> (one course).",
    description:
      "Course URL, or a bare https://<school_domain> to scrape all your courses",
  },
];

const flagDef = [
  {
    type: "input",
    name: "output",
    message: "Please enter the output directory name:",
    default: "courses",
    flags: "-o, --output <dir_name>",
    description:
      "main output directory; each course is saved in its own subfolder named after the course",
  },
  {
    type: "input",
    name: "cookies",
    message: "Please enter the path to the cookies file:",
    default: "cookies.json",
    flags: "-c, --cookies <path>",
    description: "path to cookies file (JSON or Netscape HTTP Cookie File)",
    onlyShowValid: true,
    validate: (input) => {
      if (!fs.existsSync(input))
        return "File does not exist. Please enter a valid path.";
      return true;
    },
  },
  {
    type: "confirm",
    name: "a",
    message: "Do you want to scrape assignments?",
    default: false,
    flags: "-a",
    description: "scrape assignments",
  },
  {
    type: "confirm",
    name: "m",
    message: "Do you want to scrape modules?",
    default: false,
    flags: "-m",
    description: "scrape modules",
  },
  {
    type: "confirm",
    name: "q",
    message: "Do you want to scrape quizzes?",
    default: false,
    flags: "-q",
    description: "scrape quizzes",
  },
  {
    type: "confirm",
    name: "v",
    message: "Do you want to scrape the Videos (Panopto) page?",
    default: false,
    flags: "-v",
    description: "scrape the Videos (Panopto) page",
  },
  {
    type: "confirm",
    name: "s",
    message: "Do you want to scrape the Study.Net Materials page?",
    default: false,
    flags: "-s",
    description: "scrape the Study.Net Materials page",
  },
  {
    type: "confirm",
    name: "t",
    message:
      "Do you want to transcribe downloaded videos? (runs config.json transcribeCommand)",
    default: false,
    flags: "-t",
    description: "transcribe downloaded videos via config.json transcribeCommand",
  },
  {
    type: "confirm",
    name: "dryRun",
    message:
      "Do you want a dry run (probe for inaccessible articles/artifacts without downloading)?",
    default: false,
    flags: "--dry-run",
    description:
      "probe every article/artifact for accessibility and write dry-run-report.csv, without downloading anything",
  },
  {
    type: "confirm",
    name: "report",
    message:
      "Do you want to write a CSV report of every downloaded asset (report.csv)?",
    default: false,
    flags: "--report",
    description: "write a report.csv listing every downloaded asset",
  },
  {
    type: "confirm",
    name: "wiki",
    message:
      "Do you want to organize the output as an LLM Wiki (raw/ + index.md + wiki/)?",
    default: false,
    flags: "--wiki",
    description:
      "organize output into the Karpathy LLM Wiki layout (raw/, wiki/, index.md)",
  },
  {
    type: "confirm",
    name: "octarine",
    message:
      "Do you want to organize the output as an Octarine workspace (.attachments/ + course notes)?",
    default: false,
    flags: "--octarine",
    description:
      "organize output into an Octarine workspace (.attachments/, course notes, Index.md)",
  },
  {
    type: "confirm",
    name: "fresh",
    message:
      "Do you want a fresh run (wipe each course folder and re-download everything)?",
    default: false,
    flags: "--fresh",
    description:
      "wipe each course folder and re-download from scratch; the default resumes, keeping files already on disk",
  },
  {
    type: "confirm",
    name: "force",
    message:
      "Do you want to force re-downloading files already marked complete (e.g. if you suspect a file on disk is corrupt)?",
    default: false,
    flags: "--force",
    description:
      "re-download assets even when the manifest says they're already complete (default: trust the manifest and skip them)",
  },
  {
    type: "confirm",
    name: "prune",
    message:
      "Do you want to delete local files whose source is no longer in the course (e.g. archived/removed content)?",
    default: false,
    flags: "--prune",
    description:
      "delete local files whose source is gone from the course (default: keep them, only flag them in the manifest)",
  },
];

// Job mode, signalled by an environment variable rather than a subcommand.
//
// The web app re-launches this same executable to run a scrape in a child
// process (see web/jobs.js for why it is not done in-process). An argv
// subcommand cannot carry that signal: inside a pkg binary the bootstrap
// intercepts the first argument as a script path to run, so the packaged
// build silently did nothing at all while the same code worked from source —
// the exact class of divergence that ships a binary nobody can use. An env var
// is read identically by every runtime, and carries the spec without any
// quoting or length limits.
if (process.env.CANVAS_SCRAPER_JOB) {
  const { runJob } = await import("./web/job-child.js");
  await runJob();
} else {

const program = new Command();
program
  .name("Canvas Scraper CLI")
  .description(
    "A NodeJS command-line interface for scraping and downloading data (e.g. assignments and modules) from a Canvas course."
  );

argDef.forEach((arg) => program.argument(arg.name, arg.description));

flagDef.forEach((flag) =>
  program.option(flag.flags, flag.description, flag.default)
);

program.option("--all", "scrape all content types (-a -m -q -v -s)");
program.option(
  "--courses <ids>",
  "comma-separated course ids to scrape (subset of a bare-domain URL); omit for all courses"
);
program.option("--tui", "run with the interactive terminal UI (Ink)");
program.option(
  "--login",
  "open a browser to log in and capture cookies before scraping"
);
program.option(
  "--login-mode <mode>",
  "cookie capture strategy for --login (fresh)",
  "fresh"
);

// `login` subcommand: capture cookies interactively, then exit (no scrape).
program
  .command("login [url]")
  .description(
    "open a browser to log in and save your Canvas (and Panopto) cookies"
  )
  .option("-c, --cookies <path>", "path to write the cookies file", "cookies.json")
  .option("--login-mode <mode>", "cookie capture strategy (fresh)", "fresh")
  .action(async (url, opts) => {
    try {
      // Every flow drives a real Chrome; fail early with install help if absent.
      ensureChrome();
      if (!url) {
        const { loginUrl } = await inquirer.prompt([
          {
            type: "input",
            name: "loginUrl",
            message:
              "Enter your Canvas URL (https://<school_domain>, or a course URL):",
            validate: (input) =>
              /^https:\/\/[^/]+(\/courses\/[^/]+)?\/?$/.test(input) ||
              "Invalid URL. Use https://<school_domain> or https://<school_domain>/courses/<course_id>.",
          },
        ]);
        url = loginUrl;
      }
      await runLogin(url, { cookies: opts.cookies, loginMode: opts.loginMode });
    } catch (e) {
      helpers.print("ERROR", "LOGIN", e.message || String(e), 0);
      process.exit(1);
    }
  });

// `app` subcommand: a local web UI over the archive. Loopback-only, and
// read-only in this milestone — it reads the manifests and the cookies file
// and can open what it finds, but it cannot start a scrape yet.
program
  .command("app")
  .alias("gui")
  .alias("serve")
  .description(
    "open the local web app for browsing the archive and checking sessions " +
      "(uses the global -o/--output and -c/--cookies)"
  )
  .option("--port <n>", "port to listen on", (v) => parseInt(v, 10), 7373)
  .option("--no-open", "don't launch a browser")
  .option("--selftest", "check the app's assets are present, print a summary, exit")
  // -o/--output and -c/--cookies are deliberately NOT redeclared here. The
  // program already defines both, and because it also takes a positional
  // argument, commander binds those flags to the program in every ordering —
  // a subcommand copy would silently never receive the user's value and would
  // hand back its own default instead. Read the program's options instead.
  .action(async (opts, cmd) => {
    try {
      const parent = cmd.parent.opts();

      // --selftest guards the one failure this app can ship with silently.
      // The browser files are inlined into the bundle at build time, because
      // a packaged binary has no web/public on disk to read. If that plugin
      // ever stops matching, the build still succeeds and `--help` still
      // passes — the app just serves 404s to every user. So check it in CI.
      if (opts.selftest) {
        const { readAsset, assetNames, isInlined } = await import("./web/assets.js");
        const names = assetNames();
        const missing = ["index.html", "app.css", "app.js"].filter((n) => !readAsset(n));
        helpers.print(
          missing.length ? "ERROR" : "NOTE",
          "APP",
          `selftest: ${names.length} asset(s), source=${isInlined() ? "inlined" : "disk"}` +
            (missing.length ? ` — MISSING ${missing.join(", ")}` : ""),
          0
        );
        if (missing.length) process.exit(1);

        // Round-trip a no-op job. Launching this executable as its own child
        // is the other thing that can break silently per runtime — it did,
        // when the signal was a subcommand and a packaged binary's bootstrap
        // claimed it before our code ran. The binary still built and --help
        // still passed; jobs simply never started.
        const { JobRunner } = await import("./web/jobs.js");
        const runner = new JobRunner();
        const ok = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 20000);
          runner.subscribe((e) => {
            if (e.type === "job" && e.job && e.job.status === "done") {
              clearTimeout(timer);
              resolve(true);
            }
            if (e.type === "job" && e.job && e.job.status === "failed") {
              clearTimeout(timer);
              resolve(false);
            }
          });
          runner.start({ kind: "noop" });
        });
        helpers.print(
          ok ? "NOTE" : "ERROR",
          "APP",
          `selftest: child job round-trip ${ok ? "ok" : "FAILED"}`,
          0
        );
        process.exit(ok ? 0 : 1);
      }

      const { startServer } = await import("./web/server.js");
      const { openUrl } = await import("./web/opener.js");
      const srv = await startServer({
        port: opts.port,
        output: parent.output,
        cookies: parent.cookies,
      });
      helpers.print("NOTE", "APP", `Listening on http://127.0.0.1:${srv.port}`, 0);
      helpers.print("NOTE", "APP", `Archive: ${srv.roots[0]}`, 0);
      // The token is in the URL, which is how a freshly opened tab gets it;
      // the page strips it from its own address bar immediately.
      helpers.print("NOTE", "APP", `Open: ${srv.url}`, 0);
      helpers.print("NOTE", "APP", "Press Ctrl-C to stop, or use Quit in the app.", 0);
      if (opts.open !== false) openUrl(srv.url);
      // Deliberately does not resolve: the server owns the process lifetime.
      await new Promise(() => {});
    } catch (e) {
      helpers.print("ERROR", "APP", e.message || String(e), 0);
      process.exit(1);
    }
  });

// `import` subcommand: file manually-obtained content into the scraper's own
// layout, using the gaps recorded in report-skipped.csv / download-diagnostics.
// No browser is needed — this is a pure filesystem operation.
program
  .command("import [output]")
  .description(
    "import manually-downloaded files into the scrape output, mapping them to the gaps in report-skipped.csv"
  )
  .option("-o, --output <dir>", "output directory to import into", "courses")
  .option(
    "--from <path>",
    "extra worklist source (a .csv or .jsonl of gaps) in addition to the output dir's reports"
  )
  .option("--manifest <path>", "manifest file mapping dropped files to gap URLs (default <dir>/import/manifest.csv)")
  .option("--dir <path>", "folder holding the dropped files (default <output>/import)")
  .option("--interactive", "prompt to match each unmapped dropped file to a gap")
  .option("--dry-run", "show what would be imported without copying anything")
  .action(async (output, opts, cmd) => {
    try {
      // The parent program also declares --dry-run / -o (for the scrape flow),
      // and commander routes a colliding flag to the parent, so read merged
      // (global + local) options to see --dry-run and --output here.
      const merged = cmd.optsWithGlobals();
      const dir = output || merged.output || "courses";
      await runImport(
        dir,
        {
          from: merged.from,
          manifest: merged.manifest,
          dir: merged.dir,
          interactive: !!merged.interactive,
          dryRun: !!merged.dryRun,
        },
        { prompt: promptForMatches }
      );
    } catch (e) {
      helpers.print("ERROR", "IMPORT", e.message || String(e), 0);
      process.exit(1);
    }
  });

/**
 * Interactive matcher for `import --interactive`: for each dropped file not yet
 * in the manifest, asks which gap it fills. Returns manifest entries.
 * @param {Array} worklist gaps from the reports
 * @param {string[]} files unmapped dropped file basenames
 * @param {Array} _log the import log (unused here)
 * @param {{gapLabel:function}} helpersIn label helper from core/import.js
 * @returns {Promise<Array<{file:string,url:string}>>}
 */
async function promptForMatches(worklist, files, _log, { gapLabel }) {
  const entries = [];
  for (const file of files) {
    const { url } = await inquirer.prompt([
      {
        type: "list",
        name: "url",
        message: `Which item is "${file}" for?`,
        pageSize: 15,
        choices: [
          ...worklist.map((row) => ({
            name: `${gapLabel(row)}  —  ${row.reason || "gap"}${
              row.courseName ? `  [${row.courseName}]` : ""
            }`,
            value: row.url,
          })),
          new inquirer.Separator(),
          { name: "Skip this file", value: "" },
        ],
      },
    ]);
    if (url) entries.push({ file, url });
  }
  return entries;
}

program.action(async (url, options) => {
  try {
    // Every flow drives a real Chrome; fail early with install help if absent.
    ensureChrome();

    // Normalize --courses into the courseIds array runScrape expects.
    if (typeof options.courses === "string") {
      options.courseIds = options.courses
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // No URL -> the unified Ink wizard: it prompts for the URL, then shows an
    // action menu (Log in / About / Scrape …). Scraping browses the courses
    // first, then asks what to download — all in one terminal UI.
    if (!url) {
      requireTty("the interactive wizard");
      await renderTui(undefined, {});
      return;
    }

    // Whether the user asked to scrape specific content up front. When they
    // didn't (a bare interactive `<url>` or `--tui <url>`), open the action
    // menu instead of scraping; flag-driven runs stay non-interactive.
    const hasContentFlags =
      options.a || options.m || options.q || options.v || options.s || options.all;

    // Passing --courses or --dry-run is an explicit non-interactive intent to
    // scrape (content defaults to everything), so don't divert to the action
    // menu for it.
    if (!hasContentFlags && !options.login && !options.courses && !options.dryRun) {
      requireTty("the interactive menu");
      await renderTui(url, { ...options, _menu: true });
      return;
    }

    // --tui renders the run in an Ink terminal UI; otherwise stream to the
    // console. The TUI drives --login itself (as an interactive first phase),
    // so only run the standalone capture here for the non-TUI path.
    if (options.tui) {
      requireTty("--tui");
      await renderTui(url, options);
      return;
    }

    // --login: capture fresh cookies into options.cookies before scraping.
    if (options.login) {
      await runLogin(url, {
        cookies: options.cookies,
        loginMode: options.loginMode,
      });
    }

    await runScrape(url, options);

    // runScrape has returned, which means the browser is closed and every
    // report is on disk — the run is complete and nothing further is owed.
    //
    // Puppeteer and node-fetch both tend to leave a stray handle behind (a
    // socket the peer never finished closing, a pipe from a spawn that failed),
    // and one open handle is enough to keep the event loop alive forever. The
    // CLI would then sit at 0% CPU with its work finished, which in cron or CI
    // hangs the job until it times out. Known leaks are fixed at the source;
    // this makes the exit deterministic regardless of what else lingers.
    //
    // Exiting from the stdout drain callback rather than calling process.exit()
    // outright: stdout is asynchronous when it's a pipe, so a bare exit here
    // could truncate the final lines of the report.
    await exitWhenFlushed(0);
  } catch (e) {
    helpers.print("ERROR", "SCRAPE", e.message || String(e), 0);
    process.exit(1);
  }
});

/**
 * Refuses an interactive mode when there is no terminal to be interactive in.
 *
 * Ink needs raw mode on stdin. Without a TTY — a pipe, a cron job, a CI step,
 * a dev-server wrapper — it throws "Raw mode is not supported" and buries the
 * reason under a React reconciler stack trace, which tells the reader nothing
 * about what they did or what to do instead. Say it plainly and name the ways
 * out.
 * @param {string} what the mode being refused, for the message
 */
function requireTty(what) {
  if (process.stdin.isTTY) return;
  helpers.print(
    "ERROR",
    "TTY",
    `${what} needs a terminal, and this process has no TTY on stdin.`,
    0
  );
  helpers.print(
    "NOTE",
    "TTY",
    "Run it in a terminal, or use the web app (`canvas-scraper app`), or pass " +
      "flags for a non-interactive scrape (e.g. `--all <url>`; see --help).",
    0
  );
  process.exit(1);
}

/**
 * Exits once stdout has drained, so no output is truncated on the way out.
 * Falls back to exiting anyway if the drain never reports back.
 * @param {number} code process exit code
 */
function exitWhenFlushed(code) {
  return new Promise(() => {
    let done = false;
    const bail = () => {
      if (done) return;
      done = true;
      process.exit(code);
    };
    // If stdout is wedged, don't hang on the very thing we're fixing.
    setTimeout(bail, 2000).unref();
    process.stdout.write("", bail);
  });
}

program.parse();

} // end of non-job mode
