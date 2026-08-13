import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredSources = new Set([
  "harness/LICENSE",
  "harness/apps/cli/src/bin.ts",
  "harness/apps/web/src/main.ts",
  "harness/package.json",
  "harness/pnpm-lock.yaml",
]);

const { stdout } = await execFileAsync(
  "git",
  [
    "-c",
    `safe.directory=${desktopRoot}`,
    "-C",
    desktopRoot,
    "ls-files",
    "--stage",
    "-z",
    "--",
    "harness",
  ],
  { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
);

const entries = stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((record) => {
    const match = /^(\d+) [0-9a-f]+ \d+\t(.+)$/.exec(record);
    if (!match) throw new Error(`Unexpected git ls-files record: ${record}`);
    return { mode: match[1], path: match[2] };
  });

if (entries.some(({ mode }) => mode === "160000")) {
  throw new Error("harness/ is recorded as a Git submodule instead of vendored source.");
}

if (entries.length < 1_000) {
  throw new Error(
    `Only ${entries.length} Harness files are tracked; the vendored source tree is incomplete.`,
  );
}

const trackedPaths = new Set(entries.map(({ path }) => path));
const missing = [...requiredSources].filter((path) => !trackedPaths.has(path));
if (missing.length > 0) {
  throw new Error(`Required Harness sources are not tracked:\n${missing.join("\n")}`);
}

console.log(
  `[harness] Verified ${entries.length} tracked source files with no Git submodule entry.`,
);
