import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

import {
  CLIENT_BUNDLES_MARKER,
  apply,
  collectDesktopClientBundles,
  injectDesktopClientBundles,
  injectThemeBridge,
} from '../src/index.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')
const pluginEntry = id => pathToFileURL(resolve(repositoryRoot, 'plugins', id, 'lib', 'index.mjs')).href

test('theme bridge is injected once and speaks the shell colorScheme contract', () => {
  const source = '<html><head></head><body data-ds-dark-theme><main></main></body></html>'
  const first = injectThemeBridge(source)
  assert.match(first, /<body data-ds-dark-theme>\s*<script data-dsh-desktop-theme-bridge>/)
  assert.match(first, /colorScheme/)
  assert.match(first, /deepseek-harness:theme-request/)
  assert.equal(injectThemeBridge(first), first)
})

test('theme bridge rejects malformed shell HTML loudly', () => {
  assert.throws(() => injectThemeBridge('<html><head></head></html>'), /opening <body>/)
})

test('file-mounted standard packages contribute their declared browser metadata', () => {
  const bundles = collectDesktopClientBundles([
    { options: { name: pluginEntry('dsh-attachments') } },
    { options: { name: pluginEntry('dsh-model-capabilities') } },
    { options: { name: '@deepseek-ai/dsh-base' } },
  ])

  assert.deepEqual(bundles.map(bundle => bundle.entry.id), [
    'dsh-attachments',
    'dsh-model-capabilities',
  ])
  assert.deepEqual(bundles[0].entry.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])
  assert.equal(bundles[0].entry.immediately, true)
  assert.match(bundles[0].entry.url, /^\/desktop-plugin-bundles\/dsh-attachments\/client\.js\?rev=[a-f0-9]{12}$/)
  assert.ok(bundles[0].body.byteLength > 0)
})

test('Desktop bundles merge into the standard boot graph once', () => {
  const bundles = collectDesktopClientBundles([
    { options: { name: pluginEntry('dsh-attachments') } },
  ])
  const source = '<html><head><script>window.__DSH_BOOT__ = {"rev":"base","entries":[{"id":"core","url":"/plugins/core/client.js?rev=1","rev":"1"}]}</script><script src="/shell.js"></script></head><body></body></html>'
  const first = injectDesktopClientBundles(source, bundles)

  assert.match(first, new RegExp(`<script ${CLIENT_BUNDLES_MARKER}>\\(\\(\\) =>`))
  assert.match(first, /"id":"dsh-attachments"/)
  assert.ok(first.indexOf('window.__DSH_BOOT__ = ') < first.indexOf(CLIENT_BUNDLES_MARKER))
  assert.ok(first.indexOf(CLIENT_BUNDLES_MARKER) < first.indexOf('</head>'))

  const script = first.match(new RegExp(`<script ${CLIENT_BUNDLES_MARKER}>([\\s\\S]*?)</script>`))[1]
  const window = { __DSH_BOOT__: { rev: 'base', entries: [{ id: 'core', url: '/core.js', rev: '1' }] } }
  vm.runInNewContext(script, { window, Set, Error })
  assert.deepEqual(
    window.__DSH_BOOT__.entries.map(row => row.id),
    ['core', 'dsh-attachments'],
  )
  assert.match(window.__DSH_BOOT__.rev, /^base-desktop-[a-f0-9]{12}$/)
  assert.equal(injectDesktopClientBundles(first, bundles), first)
})

test('Desktop bundle injection reports malformed shell HTML', () => {
  const bundles = collectDesktopClientBundles([
    { options: { name: pluginEntry('dsh-attachments') } },
  ])
  assert.throws(
    () => injectDesktopClientBundles('<html><head><body></body></html>', bundles),
    /closing <\/head>/,
  )
})

test('apply registers exact routes and both index transforms', () => {
  const routes = []
  const taps = []
  const ctx = {
    loader: {
      entries: () => [{ options: { name: pluginEntry('dsh-attachments') } }],
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
      tapIndex: (tap) => {
        taps.push(tap)
        return () => {}
      },
    },
    effect: (factory) => factory(),
  }

  apply(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/desktop-plugin-bundles/dsh-attachments/client.js')
  assert.equal(taps.length, 2)

  let status
  let headers
  let responseBody
  routes[0].handler(
    { method: 'GET' },
    {
      writeHead: (nextStatus, nextHeaders) => {
        status = nextStatus
        headers = nextHeaders
      },
      end: (body) => { responseBody = body },
    },
  )
  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'text/javascript; charset=utf-8')
  assert.match(responseBody.toString('utf8'), /dsh-attachments/)
})
