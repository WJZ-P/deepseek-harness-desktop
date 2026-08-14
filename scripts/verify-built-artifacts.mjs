import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const platform = { win32: "windows", linux: "linux", darwin: "macos" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (platform === undefined || arch === undefined) {
  throw new Error(`Unsupported artifact host: ${process.platform}-${process.arch}`);
}

const stem = `DeepSeek-Harness-Desktop-${version}-${platform}-${arch}`;
const names = process.platform === "win32"
  ? [`DeepSeek-Harness-Desktop-${version}-windows-x64-portable.zip`]
  : process.platform === "linux"
    ? [`${stem}.AppImage`, `${stem}.deb`]
    : [`${stem}.dmg`];

async function hashFile(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

for (const name of names) {
  const path = join(root, "dist", name);
  const checksumPath = `${path}.sha256`;
  await access(path);
  await access(checksumPath);
  if ((await stat(path)).size === 0) throw new Error(`${name} is empty`);
  const expected = (await readFile(checksumPath, "utf8")).trim().split(/\s+/)[0];
  const actual = await hashFile(path);
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(`${name} SHA-256 mismatch`);
  }
  console.log(`[release] Verified ${name} (${actual}).`);
}
