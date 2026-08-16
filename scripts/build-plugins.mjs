import { access, copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const desktopBridgeRoot = join(repositoryRoot, 'desktop-plugins', 'desktop-bridge')
const publicPluginsRoot = join(repositoryRoot, 'plugins')

async function buildDesktopBridge() {
  const outDir = join(desktopBridgeRoot, 'lib')
  await mkdir(outDir, { recursive: true })
  await copyFile(join(desktopBridgeRoot, 'src', 'index.mjs'), join(outDir, 'index.mjs'))
  console.log('[plugins] Built Desktop-only Host plugin desktop-bridge')
}

async function assertStandardBundle(root, directory) {
  const manifestPath = join(root, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const requiredFiles = [
    'README.md',
    'LICENSE',
    'cordis.patch.yml',
    join('scripts', 'build.mjs'),
  ]

  if (manifest.name !== directory) {
    throw new Error(`${directory}: package name must match its plugins/ directory`)
  }
  if (manifest.private === true) {
    throw new Error(`${directory}: reusable DSH bundles must be publishable, not private`)
  }
  if (manifest.main !== './lib/index.mjs') {
    throw new Error(`${directory}: main must point to ./lib/index.mjs`)
  }
  if (manifest.exports?.['.'] !== './lib/index.mjs'
    || manifest.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') {
    throw new Error(`${directory}: exports must expose the Host entry and bundle patch`)
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error(`${directory}: dsh.bundle.patch must point to ./cordis.patch.yml`)
  }
  if (manifest.exports?.['./client'] !== undefined
    && manifest.dsh?.client?.platform !== 'web') {
    throw new Error(`${directory}: browser bundles must declare dsh.client.platform as web`)
  }
  if (manifest.dsh?.client?.platform === 'web'
    && manifest.exports?.['./client'] === undefined) {
    throw new Error(`${directory}: dsh.client web bundles must export ./client`)
  }
  const officialClientPeers = (manifest.dsh?.client?.inject ?? [])
    .filter(name => name.startsWith('@deepseek-ai/'))
    .filter(name => manifest.peerDependencies?.[name] === undefined)
  if (officialClientPeers.length > 0) {
    throw new Error(`${directory}: dsh.client official packages must be peerDependencies: ${officialClientPeers.join(', ')}`)
  }
  const officialRuntimeDependencies = Object.keys(manifest.dependencies ?? {})
    .filter(name => name.startsWith('@deepseek-ai/'))
  if (officialRuntimeDependencies.length > 0) {
    throw new Error(`${directory}: official packages belong in peerDependencies: ${officialRuntimeDependencies.join(', ')}`)
  }
  const publishedFiles = ['lib/', 'cordis.patch.yml', 'README.md', 'LICENSE']
  if (!Array.isArray(manifest.files)
    || publishedFiles.some(filename => !manifest.files.includes(filename))) {
    throw new Error(`${directory}: package files must include ${publishedFiles.join(', ')}`)
  }
  if (!manifest.scripts?.build || !manifest.scripts?.prepare || !manifest.scripts?.test) {
    throw new Error(`${directory}: package scripts must provide build, prepare, and test`)
  }
  if (!manifest.engines?.node || !manifest.license) {
    throw new Error(`${directory}: package must declare Node compatibility and a license`)
  }
  if (!manifest.keywords?.includes('dsh-plugin')) {
    throw new Error(`${directory}: package keywords must include dsh-plugin`)
  }
  for (const filename of requiredFiles) {
    await access(join(root, filename))
  }
}

async function buildPublicPlugins() {
  const entries = await readdir(publicPluginsRoot, { withFileTypes: true })
  for (const entry of entries.filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(publicPluginsRoot, entry.name)
    await assertStandardBundle(root, entry.name)
    await import(`${pathToFileURL(join(root, 'scripts', 'build.mjs')).href}?build=${Date.now()}`)
  }
}

await buildDesktopBridge()
await buildPublicPlugins()
