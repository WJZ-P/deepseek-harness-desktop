import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const harnessRoot = join(desktopRoot, "harness");
const releaseRuntime = join(desktopRoot, "release-runtime");
const stagingRoot = join(releaseRuntime, "harness");
const bundledPlugins = [
  { id: "desktop-bridge", root: "desktop-plugins", directory: "desktop-bridge" },
  { id: "dsh-attachments", root: "plugins", directory: "dsh-attachments" },
  { id: "dsh-model-capabilities", root: "plugins", directory: "dsh-model-capabilities" },
].map((plugin) => ({
  ...plugin,
  source: join(desktopRoot, plugin.root, plugin.directory),
  staged: join(stagingRoot, plugin.root, plugin.directory),
}));
const outputRoot = join(desktopRoot, "dist");
const platformNames = { win32: "windows", linux: "linux", darwin: "macos" };
const architectureNames = { x64: "x64", arm64: "arm64" };
const platformName = platformNames[process.platform];
const architectureName = architectureNames[process.arch];
if (platformName === undefined || architectureName === undefined) {
  throw new Error(`Unsupported release host: ${process.platform}-${process.arch}`);
}
const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
const nodePath = join(releaseRuntime, nodeBinaryName);
const executableName = process.platform === "win32"
  ? "deepseek-harness-desktop.exe"
  : "deepseek-harness-desktop";
const tauriExecutable = join(
  desktopRoot,
  "src-tauri",
  "target",
  "release",
  executableName,
);
const bundleRoot = join(
  desktopRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
);
const packageJson = JSON.parse(
  await readFile(join(desktopRoot, "package.json"), "utf8"),
);
const portableName = `DeepSeek-Harness-Desktop-${packageJson.version}-windows-x64-portable`;
const portableRoot = join(outputRoot, portableName);
const portableArchive = join(outputRoot, `${portableName}.zip`);
const portableExecutable = join(portableRoot, "DeepSeek Harness.exe");
const releaseStem = `DeepSeek-Harness-Desktop-${packageJson.version}-${platformName}-${architectureName}`;

function pnpmInvocation(args) {
  if (process.env.npm_execpath?.toLowerCase().includes("pnpm")) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
    };
  }
  return { command: "pnpm", args };
}

async function run(command, args, options = {}) {
  console.log(`[release] ${basename(command)} ${args.join(" ")}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? desktopRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            signal
              ? `${basename(command)} was terminated by ${signal}`
              : `${basename(command)} exited with code ${code}`,
          ),
        );
      }
    });
  });
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function prepareHarness() {
  const invocation = pnpmInvocation(["run", "harness:prepare"]);
  await run(invocation.command, invocation.args);
}

async function prepareBundledPlugins() {
  const invocation = pnpmInvocation(["run", "plugin:build"]);
  await run(invocation.command, invocation.args);
}

async function deployCli() {
  await rm(releaseRuntime, { recursive: true, force: true });
  await mkdir(releaseRuntime, { recursive: true });
  const invocation = pnpmInvocation([
    "--dir",
    harnessRoot,
    "--filter",
    "@deepseek-ai/dsh",
    "deploy",
    "--prod",
    "--config.node-linker=hoisted",
    "--config.inject-workspace-packages=true",
    "--config.auto-install-peers=true",
    "--config.force-legacy-deploy=true",
    stagingRoot,
  ]);
  await run(invocation.command, invocation.args);
}

async function stageBundledPlugins() {
  for (const plugin of bundledPlugins) {
    await mkdir(join(plugin.staged, "lib"), { recursive: true });
    await copyFile(join(plugin.source, "package.json"), join(plugin.staged, "package.json"));
    await cp(join(plugin.source, "lib"), join(plugin.staged, "lib"), {
      recursive: true,
      dereference: true,
    });
    for (const filename of ["cordis.patch.yml", "README.md", "LICENSE"]) {
      const source = join(plugin.source, filename);
      try {
        await copyFile(source, join(plugin.staged, filename));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    console.log(`[release] Staged bundled plugin: ${plugin.staged}`);
  }
}

function resolvePackageManifest(anchor, packageName) {
  let directory = dirname(anchor);
  const segments = packageName.split("/");
  while (true) {
    const candidate = join(directory, "node_modules", ...segments, "package.json");
    if (pathExistsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const requireFrom = createRequire(anchor);
  try {
    return requireFrom.resolve(`${packageName}/package.json`);
  } catch {
    try {
      const entry = requireFrom.resolve(packageName);
      let directory = dirname(entry);
      while (dirname(directory) !== directory) {
        const manifest = join(directory, "package.json");
        try {
          if (requireFrom.resolve(manifest) === manifest) return manifest;
        } catch {
          // Keep walking toward the package root.
        }
        directory = dirname(directory);
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function pathExistsSync(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function copyPackage(sourceManifest, packageName) {
  const source = dirname(sourceManifest);
  const destination = join(stagingRoot, "node_modules", ...packageName.split("/"));
  if (await pathExists(destination)) return;
  await mkdir(dirname(destination), { recursive: true });
  const sourceModules = join(source, "node_modules");
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => path !== sourceModules && !path.startsWith(sourceModules + sep),
  });
}

async function materializeHarnessClosure() {
  const sourceAppManifest = join(harnessRoot, "apps", "cli", "package.json");
  const workspacePackages = await indexWorkspacePackages();
  const sourceQueue = [sourceAppManifest];
  const seen = new Set();

  while (sourceQueue.length > 0) {
    const manifestPath = sourceQueue.shift();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const dependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    for (const packageName of dependencies) {
      const workspaceManifest = workspacePackages.get(packageName);
      if (workspaceManifest === undefined) continue;
      if (seen.has(packageName)) continue;
      seen.add(packageName);
      sourceQueue.push(workspaceManifest);
      await copyPackage(workspaceManifest, packageName);
    }
  }

  const unresolved = [];
  const runtimeQueue = [join(stagingRoot, "package.json")];
  const runtimeSeen = new Set();
  while (runtimeQueue.length > 0) {
    const manifestPath = runtimeQueue.shift();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const dependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    for (const packageName of dependencies) {
      if (runtimeSeen.has(packageName)) continue;
      runtimeSeen.add(packageName);
      const dependencyManifest = resolvePackageManifest(manifestPath, packageName);
      if (dependencyManifest === undefined) {
        if (manifest.peerDependenciesMeta?.[packageName]?.optional !== true) {
          unresolved.push(`${manifest.name} -> ${packageName}`);
        }
      } else {
        runtimeQueue.push(dependencyManifest);
      }
    }
  }
  if (unresolved.length > 0) {
    throw new Error(`Harness runtime closure is incomplete:\n${unresolved.join("\n")}`);
  }
  await Promise.all([
    rm(join(stagingRoot, "node_modules", ".bin"), { recursive: true, force: true }),
    rm(join(stagingRoot, "node_modules", ".pnpm"), { recursive: true, force: true }),
    rm(join(stagingRoot, "node_modules", ".modules.yaml"), { force: true }),
    rm(join(stagingRoot, "pnpm-lock.yaml"), { force: true }),
  ]);
  await prunePackageManagerArtifacts(stagingRoot);
  await assertNoSymlinks(stagingRoot);
  console.log(`[release] Verified ${runtimeSeen.size} runtime packages.`);
}

async function pruneIncompatibleNativeVariants() {
  if (process.platform !== "linux") return;

  // The x64 Koffi package ships glibc and musl addons together. AppImage and
  // our Ubuntu build target use glibc; leaving the unused musl addon in the
  // expanded resource tree makes linuxdeploy look for libc.musl-x86_64.so.1.
  const incompatiblePaths = [
    join(
      stagingRoot,
      "node_modules",
      "@koromix",
      "koffi-linux-x64",
      "musl_x64",
    ),
  ];
  for (const path of incompatiblePaths) {
    if (await pathExists(path)) {
      await rm(path, { recursive: true, force: true });
      console.log(`[release] Removed incompatible native runtime variant: ${path}`);
    }
  }
}

async function indexWorkspacePackages() {
  const packages = new Map();
  const ignored = new Set([".git", "dist", "lib", "node_modules", "target"]);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const manifest = join(path, "package.json");
      if (await pathExists(manifest)) {
        const parsed = JSON.parse(await readFile(manifest, "utf8"));
        if (typeof parsed.name === "string") packages.set(parsed.name, manifest);
      }
      await visit(path);
    }
  };
  for (const directory of ["apps", "native", "packages", "vendor"]) {
    await visit(join(harnessRoot, directory));
  }
  return packages;
}

async function prunePackageManagerArtifacts(directory) {
  const insideNodeModules = basename(directory) === "node_modules";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      insideNodeModules
      && (entry.name === ".bin"
        || entry.name === ".pnpm"
        || entry.name === ".modules.yaml")
    ) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) await prunePackageManagerArtifacts(path);
  }
}

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Harness runtime contains a non-portable symlink: ${path}`);
    }
    if (metadata.isDirectory()) await assertNoSymlinks(path);
  }
}

async function copyNodeRuntime() {
  const version = process.versions.node.split(".").map(Number);
  const supported =
    (version[0] === 22 && version[1] >= 19) || version[0] >= 24;
  if (!supported) {
    throw new Error(`Node ${process.versions.node} is outside Harness's supported range.`);
  }
  await copyFile(process.execPath, nodePath);
  if (process.platform !== "win32") await chmod(nodePath, 0o755);
  console.log(
    `[release] Embedded Node ${process.versions.node} for ${platformName}-${architectureName}.`,
  );
}

async function terminateChild(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await new Promise((done) => {
      const timeout = setTimeout(() => {
        killer.kill();
        child.kill();
        done();
      }, 5_000);
      const finish = () => {
        clearTimeout(timeout);
        done();
      };
      killer.once("exit", finish);
      killer.once("error", finish);
    });
    return;
  }

  child.kill("SIGTERM");
  await new Promise((done) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      done();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      done();
    });
  });
}

async function smokeRuntime() {
  const smokeOverlay = join(releaseRuntime, "desktop-smoke.patch.yml");
  const overlayRows = bundledPlugins.map((plugin) => {
    const pluginUrl = pathToFileURL(join(plugin.staged, "lib", "index.mjs"))
      .href.replaceAll("'", "''");
    return `    - id: ${plugin.id}\n      name: '${pluginUrl}'`;
  }).join("\n");
  await writeFile(
    smokeOverlay,
    `- insert:\n${overlayRows}\n`,
  );
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(
      nodePath,
      [
        join(stagingRoot, "lib", "bin.js"),
        "web",
        "--patch",
        smokeOverlay,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      {
        cwd: stagingRoot,
        env: {
          ...process.env,
          DSH_HOME: join(releaseRuntime, "smoke-home"),
          DSH_TELEMETRY_DISABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await terminateChild(child);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolvePromise(value);
    };
    const inspect = async () => {
      const ready = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)/m.exec(stdout);
      if (!ready) return;
      try {
        const response = await fetch(ready[1]);
        const body = await response.text();
        if (response.status !== 200 || !/<html/i.test(body)) {
          throw new Error(`Harness smoke returned HTTP ${response.status}.`);
        }
        if (!body.includes("data-dsh-desktop-theme-bridge")) {
          throw new Error("Harness smoke response is missing the desktop theme bridge.");
        }
        if (!body.includes("dsh-attachments")) {
          throw new Error("Harness smoke manifest is missing the desktop attachments bundle.");
        }
        if (!body.includes("dsh-model-capabilities")) {
          throw new Error("Harness smoke manifest is missing the model capabilities bundle.");
        }
        const clientResponse = await fetch(
          `${ready[1]}/desktop-plugin-bundles/dsh-attachments/client.js`,
        );
        const clientBody = await clientResponse.text();
        if (clientResponse.status !== 200
          || !clientBody.includes("dsh-attachments")) {
          throw new Error(`Desktop attachments bundle returned HTTP ${clientResponse.status}.`);
        }
        const capabilitiesResponse = await fetch(
          `${ready[1]}/desktop-plugin-bundles/dsh-model-capabilities/client.js`,
        );
        const capabilitiesBody = await capabilitiesResponse.text();
        if (capabilitiesResponse.status !== 200
          || !capabilitiesBody.includes("dsh-model-capabilities")) {
          throw new Error(`Model capabilities bundle returned HTTP ${capabilitiesResponse.status}.`);
        }
        await finish(undefined, { url: ready[1], bytes: body.length });
      } catch (error) {
        await finish(error);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      void inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => void finish(error));
    child.once("exit", (code) => {
      if (!settled) {
        void finish(
          new Error(
            `Harness smoke exited with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    });
    timeout = setTimeout(() => {
      void finish(
        new Error(`Harness smoke timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, 45_000);
  });
  await Promise.all([
    rm(join(releaseRuntime, "smoke-home"), { recursive: true, force: true }),
    rm(smokeOverlay, { force: true }),
  ]);
  console.log(`[release] Harness smoke passed at ${result.url} (${result.bytes} bytes).`);
}

async function buildTauri() {
  await Promise.all([
    rm(tauriExecutable, { force: true }),
    rm(bundleRoot, { recursive: true, force: true }),
  ]);
  const resourceConfig = JSON.stringify({
    bundle: {
      resources: {
        [`../release-runtime/${nodeBinaryName}`]: `runtime/${nodeBinaryName}`,
        "../release-runtime/harness": "runtime/harness",
      },
    },
  });
  const args = [
    "tauri",
    "build",
    "--ci",
    "--verbose",
    "--config",
    resourceConfig,
  ];
  if (process.platform === "win32") {
    args.push("--no-bundle");
  } else if (process.platform === "linux") {
    args.push("--bundles", "appimage,deb");
  } else {
    args.push("--bundles", "app,dmg");
  }
  const invocation = pnpmInvocation(args);
  const buildEnvironment = process.platform === "linux"
    ? {
        ...process.env,
        // linuxdeploy otherwise tries to strip the embedded Node runtime and
        // native Harness addons while walking the expanded Tauri resources.
        NO_STRIP: "1",
      }
    : process.env;
  await run(invocation.command, invocation.args, { env: buildEnvironment });
  if (!(await pathExists(tauriExecutable))) {
    throw new Error(`Tauri executable was not created: ${tauriExecutable}`);
  }
}

async function publishPortable() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The portable ZIP publisher is reserved for Windows x64.");
  }
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(join(portableRoot, "runtime"), { recursive: true });
  await Promise.all([
    copyFile(tauriExecutable, portableExecutable),
    copyFile(nodePath, join(portableRoot, "runtime", nodeBinaryName)),
    cp(stagingRoot, join(portableRoot, "runtime", "harness"), {
      recursive: true,
      dereference: true,
    }),
    writeFile(
      join(portableRoot, "README.txt"),
      [
        "DeepSeek Harness Desktop portable build",
        "",
        "Double-click DeepSeek Harness.exe to start.",
        "Keep the executable and runtime directory together.",
        "The expanded Harness runtime is available under runtime\\harness.",
        "No separate Node.js or Harness checkout is required.",
        "",
      ].join("\r\n"),
    ),
  ]);
  await run(
    "tar.exe",
    ["-a", "-cf", portableArchive, "-C", outputRoot, portableName],
    { cwd: desktopRoot },
  );
  const artifact = await stat(portableArchive);
  const archiveName = basename(portableArchive);
  await writeFile(
    `${portableArchive}.sha256`,
    await hashFile(portableArchive).then((hash) => `${hash}  ${archiveName}\n`),
  );
  console.log(
    `[release] Portable ZIP ready: ${portableArchive} (${(artifact.size / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

async function findFiles(directory, predicate) {
  const matches = [];
  if (!(await pathExists(directory))) return matches;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await findFiles(path, predicate));
    else if (entry.isFile() && predicate(path)) matches.push(path);
  }
  return matches;
}

async function publishBundle(sourceSuffix, outputSuffix) {
  const matches = await findFiles(
    bundleRoot,
    (path) => path.toLowerCase().endsWith(sourceSuffix.toLowerCase()),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${sourceSuffix} bundle under ${bundleRoot}, found ${matches.length}:\n${matches.join("\n")}`,
    );
  }

  const destination = join(outputRoot, `${releaseStem}${outputSuffix}`);
  await copyFile(matches[0], destination);
  if (outputSuffix === ".AppImage") await chmod(destination, 0o755);
  await writeChecksum(destination);
  const artifact = await stat(destination);
  console.log(
    `[release] Bundle ready: ${destination} (${(artifact.size / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

async function publishPlatformBundles() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  if (process.platform === "linux") {
    await publishBundle(".AppImage", ".AppImage");
    await publishBundle(".deb", ".deb");
    return;
  }
  if (process.platform === "darwin") {
    await publishBundle(".dmg", ".dmg");
    return;
  }
  throw new Error(`No native bundle publisher for ${process.platform}`);
}

async function writeChecksum(path) {
  const name = basename(path);
  await writeFile(
    `${path}.sha256`,
    await hashFile(path).then((hash) => `${hash}  ${name}\n`),
  );
}

async function hashFile(path) {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

await prepareHarness();
await prepareBundledPlugins();
await deployCli();
await stageBundledPlugins();
await materializeHarnessClosure();
await pruneIncompatibleNativeVariants();
await copyNodeRuntime();
await smokeRuntime();
await buildTauri();
if (process.platform === "win32") await publishPortable();
else await publishPlatformBundles();
