// Bundles the CLI into a single ESM file for packaging with @yao-pkg/pkg.
//
// pkg cannot reliably snapshot our ESM dependency graph directly: modules like
// ink and yoga-layout mix top-level `await` with `export`, which pkg's ESM->CJS
// transformer can't convert, so their sibling files (e.g. yoga's wasm blob)
// fail to resolve at runtime inside the snapshot. Pre-bundling with esbuild
// inlines all of that into one file, sidestepping the whole problem.
import { build } from "esbuild";
import { readFileSync, readdirSync } from "fs";
import path from "path";

// The web app's static files can't be read from disk at runtime: this bundle
// collapses everything into dist/app.mjs, so `import.meta.url` no longer points
// anywhere near web/public. pkg's own `assets` option can't help either — it
// scans for literal path.join(__dirname, …) patterns, and esbuild has already
// erased those by the time pkg sees the output. So inline them here, the same
// trick the devtools stub above uses to bend a module at bundle time.
const inlineWebAssets = {
  name: "inline-web-assets",
  setup(b) {
    b.onLoad({ filter: /web[\\/]assets\.js$/ }, (args) => {
      const publicDir = path.join(path.dirname(args.path), "public");
      const map = {};
      const walk = (sub) => {
        for (const entry of readdirSync(path.join(publicDir, sub), { withFileTypes: true })) {
          const rel = sub ? `${sub}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(rel);
          else map[rel] = readFileSync(path.join(publicDir, rel)).toString("base64");
        }
      };
      walk("");
      const src = readFileSync(args.path, "utf8");
      const out = src.replace("const INLINED = null;", `const INLINED = ${JSON.stringify(map)};`);
      if (out === src) throw new Error("inline-web-assets: INLINED placeholder not found");
      console.log(`  inlined ${Object.keys(map).length} web asset(s)`);
      return { contents: out, loader: "js", resolveDir: path.dirname(args.path) };
    });
  },
};

// ink lazily pulls in react-devtools-core only when DEV=true, but esbuild
// hoists that import and tries to resolve it eagerly. It isn't a dependency we
// ship, so stub it with an empty module — the code path never runs in a build.
const stubDevtools = {
  name: "stub-react-devtools-core",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["index.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/app.mjs",
  // Puppeteer used to be left external for pkg to snapshot from node_modules,
  // on the grounds that it was CJS and packaged cleanly. Since v22 it is ESM
  // ("type": "module"), and pkg cannot resolve its internal ESM graph — the
  // packaged binary died at startup with ERR_MODULE_NOT_FOUND on
  // puppeteer-core/lib/puppeteer/api/Browser.js, before any of our code ran.
  // Bundling it here sidesteps pkg's ESM handling entirely, the same reason
  // ink and yoga-layout are bundled rather than snapshotted.
  external: [],
  plugins: [stubDevtools, inlineWebAssets],
  // Bundled CommonJS deps (commander, inquirer, …) call require() for builtins
  // like "events". An ESM bundle has no require, so provide a real one.
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
  logLevel: "info",
});
