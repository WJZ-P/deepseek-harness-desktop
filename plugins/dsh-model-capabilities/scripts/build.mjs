import { build } from 'esbuild'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(pluginRoot, 'lib')
const clientId = 'dsh-model-capabilities'

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
await copyFile(join(pluginRoot, 'src', 'index.mjs'), join(outDir, 'index.mjs'))

const client = join(outDir, 'client.js')
await build({
  entryPoints: [join(pluginRoot, 'src', 'client.tsx')],
  outfile: client,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome105', 'safari15'],
  jsx: 'automatic',
  sourcemap: true,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  logLevel: 'info',
})

const output = await readFile(client, 'utf8')
if (!output.includes(`id: "${clientId}"`) || !output.includes('factory: (require)')) {
  throw new Error('dsh-model-capabilities does not implement the Harness lazy-CJS handoff')
}

console.log(`[dsh-model-capabilities] Built Host and browser bundles in ${outDir}`)
