// packages/api/build.mjs
// Bundles the API into a single ESM file with esbuild, ready for `node dist/server.js`.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const workspaceScope = "@stewardledger/";
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
].filter((name) => !name.startsWith(workspaceScope));

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// Copy PDF font assets next to the bundled server so the runtime
// resolver finds them via `new URL("./assets/...", import.meta.url)`.
// Same shape as the source tree at `src/services/reports/pdf/assets`,
// flattened into `dist/assets/` to keep the lookup path short.
const fontSrc = new URL("./src/services/reports/pdf/assets/", import.meta.url);
const fontDest = new URL("./dist/assets/", import.meta.url);
mkdirSync(fontDest, { recursive: true });
for (const entry of readdirSync(fontSrc)) {
  if (entry.endsWith(".ttf")) {
    copyFileSync(new URL(entry, fontSrc), new URL(entry, fontDest));
  }
}

console.log("API bundled to dist/server.js");
