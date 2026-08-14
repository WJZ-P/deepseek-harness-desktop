import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDesktopThemeBridge } from "./desktop-theme-bridge.mjs";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const harnessRoot = join(desktopRoot, "harness");
const harnessLockfile = join(harnessRoot, "pnpm-lock.yaml");
const requiredSources = [
  join(harnessRoot, "package.json"),
  harnessLockfile,
  join(harnessRoot, "apps", "cli", "src", "bin.ts"),
  join(harnessRoot, "apps", "web", "src", "main.ts"),
];
const dependencyMarker = join(harnessRoot, "node_modules", ".modules.yaml");
const buildArtifacts = [
  join(harnessRoot, "apps", "cli", "lib", "bin.js"),
  join(harnessRoot, "apps", "web", "dist", "index.html"),
];
const generatedDirectories = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "lib",
  "node_modules",
  "target",
  "types",
]);

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function newestSourceMtime(directory) {
  let newest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (generatedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSourceMtime(path));
    } else {
      newest = Math.max(newest, (await lstat(path)).mtimeMs);
    }
  }
  return newest;
}

function pnpmInvocation(args) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli) {
    return { command: process.execPath, args: [pnpmCli, ...args] };
  }
  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args,
  };
}

async function runPnpm(args) {
  const invocation = pnpmInvocation(args);
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: harnessRoot,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            signal
              ? `pnpm was terminated by ${signal}`
              : `pnpm exited with code ${code}`,
          ),
        );
      }
    });
  });
}

for (const source of requiredSources) {
  if (!(await statOrNull(source))) {
    throw new Error(`Vendored Harness source is incomplete: ${source}`);
  }
}

const dependencyStat = await statOrNull(dependencyMarker);
const lockfileStat = await lstat(harnessLockfile);
if (dependencyStat === null || dependencyStat.mtimeMs < lockfileStat.mtimeMs) {
  console.log("[harness] Installing vendored Harness dependencies...");
  await runPnpm(["install", "--frozen-lockfile"]);
}

const artifactStats = await Promise.all(buildArtifacts.map(statOrNull));
const sourceMtime = await newestSourceMtime(harnessRoot);
const needsBuild = artifactStats.some(
  (artifact) => artifact === null || artifact.mtimeMs < sourceMtime,
);

if (needsBuild) {
  console.log("[harness] Building vendored Harness sources...");
  await runPnpm(["run", "build"]);
} else {
  console.log("[harness] Vendored Harness is ready.");
}

await installDesktopThemeBridge(buildArtifacts[1]);
