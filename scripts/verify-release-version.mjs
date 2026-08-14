import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];

if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Expected a vMAJOR.MINOR.PATCH tag, received ${JSON.stringify(tag)}`);
}

const expected = tag.slice(1);
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(
  await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const cargoToml = await readFile(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = /^version = "([^"]+)"$/m.exec(cargoToml)?.[1];
const versions = {
  "package.json": packageJson.version,
  "tauri.conf.json": tauriConfig.version,
  "Cargo.toml": cargoVersion,
};

for (const [source, version] of Object.entries(versions)) {
  if (version !== expected) {
    throw new Error(`${source} version ${JSON.stringify(version)} does not match ${tag}`);
  }
}

console.log(`[release] ${tag} matches package, Tauri, and Cargo versions.`);
