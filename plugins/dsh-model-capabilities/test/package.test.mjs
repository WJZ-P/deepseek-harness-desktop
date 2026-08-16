import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const packageRoot = join(import.meta.dirname, '..')

test('package declares a standard installable DSH bundle', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.name, 'dsh-model-capabilities')
  assert.equal(manifest.private, undefined)
  assert.equal(manifest.main, './lib/index.mjs')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh?.client, {
    platform: 'web',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings-models',
    ],
    immediately: true,
  })
  assert.equal(manifest.dependencies, undefined)
  assert.ok(Object.keys(manifest.peerDependencies).every(name => (
    name === 'react' || name.startsWith('@deepseek-ai/')
  )))
  assert.ok(manifest.files.includes('lib/'))
  assert.match(patch, /id:\s*dsh-model-capabilities/)
  assert.match(patch, /name:\s*dsh-model-capabilities/)
})
