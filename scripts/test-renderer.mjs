import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const out = path.resolve(".tmp-tests/renderer");
mkdirSync(out, { recursive: true });
writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify({ type: "commonjs" }),
);
execFileSync(
  process.execPath,
  [
    require.resolve("typescript/bin/tsc"),
    "-p",
    "tsconfig.test.json",
    "--outDir",
    out,
  ],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  ["--test", path.join(out, "tests", "*.test.js")],
  { stdio: "inherit" },
);
