import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'

const packageRoot = join(import.meta.dirname, '..')

test('package declares a standard installable DSH bundle', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.name, 'dsh-attachments')
  assert.equal(manifest.private, undefined)
  assert.equal(manifest.main, './lib/index.mjs')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh?.client, {
    platform: 'web',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: true,
  })
  assert.equal(manifest.exports?.['./client'], './lib/client.js')
  assert.equal(manifest.dependencies, undefined)
  assert.ok(manifest.keywords.includes('dsh-plugin'))
  assert.equal(manifest.repository?.directory, 'plugins/dsh-attachments')
  assert.ok(Object.keys(manifest.peerDependencies).every(name => (
    name === 'react' || name.startsWith('@deepseek-ai/')
  )))
  assert.ok(manifest.files.includes('lib/'))
  assert.ok(manifest.files.includes('README.zh.md'))
  assert.match(patch, /id:\s*dsh-attachments/)
  assert.match(patch, /name:\s*dsh-attachments/)
})

test('marketplace fixture follows the monorepo catalog schema', async () => {
  const catalog = await readFile(join(
    packageRoot,
    'marketplace',
    'WJZ-P__deepseek-harness-desktop--plugins-dsh-attachments.yml',
  ), 'utf8')

  assert.match(catalog, /^url: https:\/\/github\.com\/WJZ-P\/deepseek-harness-desktop\/tree\/main\/plugins\/dsh-attachments$/m)
  assert.match(catalog, /^name: WJZ-P\/deepseek-harness-desktop#dsh-attachments$/m)
  assert.match(catalog, /^category: ui$/m)
  assert.match(catalog, /^  en: .+\.$/m)
  assert.match(catalog, /^  zh: .+。$/m)
})

test('installation docs use this repository instead of the unrelated npm package', async () => {
  const installSpec = 'github:WJZ-P/deepseek-harness-desktop#path:/plugins/dsh-attachments'
  for (const readme of ['README.md', 'README.zh.md']) {
    const body = await readFile(join(packageRoot, readme), 'utf8')
    assert.match(body, new RegExp(`dsh plugin --profile web add ${installSpec}`))
    assert.doesNotMatch(body, /dsh plugin --profile web add dsh-attachments(?:\s|$)/)
  }
})

test('marketplace screenshot snippet points at reviewed repository PNG files', async () => {
  const screenshotRoot = join(packageRoot, 'assets', 'screenshots')
  const names = (await readdir(screenshotRoot))
    .filter(name => name.endsWith('.png'))
    .sort()
  assert.deepEqual(names, [
    '01-drag-drop-overlay.png',
    '02-image-conversation.png',
    '03-multiple-image-preview.png',
  ])

  const snippet = JSON.parse(await readFile(join(packageRoot, 'marketplace', 'screenshots.entry.json'), 'utf8'))
  const entryUrl = 'https://github.com/WJZ-P/deepseek-harness-desktop/tree/main/plugins/dsh-attachments'
  assert.deepEqual(snippet[entryUrl].map(url => basename(new URL(url).pathname)), names)

  for (const name of names) {
    const image = await readFile(join(screenshotRoot, name))
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.ok(image.readUInt32BE(16) >= 700)
    assert.ok(image.readUInt32BE(20) >= 250)
  }

  for (const readme of ['README.md', 'README.zh.md']) {
    const body = await readFile(join(packageRoot, readme), 'utf8')
    for (const name of names) assert.match(body, new RegExp(`assets/screenshots/${name}`))
  }
})
