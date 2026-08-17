/**
 * Runtime-only bridge between the Harness page and its Tauri parent shell.
 *
 * Public plugins stay ordinary DSH bundles. Native DSH discovers their browser
 * halves from `dsh.client`; Desktop mounts the same Host artifacts by file URL,
 * so this private bridge mirrors the metadata of those active file entries into
 * the served boot graph. No public plugin needs a Tauri-specific code path.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'desktop-bridge'
export const inject = ['webServer', 'loader']

export const THEME_BRIDGE_MARKER = 'data-dsh-desktop-theme-bridge'
export const CLIENT_BUNDLES_MARKER = 'data-dsh-desktop-client-bundles'
export const CLIENT_BUNDLE_ROUTE_PREFIX = '/desktop-plugin-bundles'

const THEME_BRIDGE_SCRIPT = String.raw`<script data-dsh-desktop-theme-bridge>(() => {
  if (window.parent === window) return

  const themeType = 'deepseek-harness:theme'
  const requestType = 'deepseek-harness:theme-request'
  let lastScheme

  const currentScheme = () => document.body.hasAttribute('data-ds-dark-theme')
    || document.documentElement.style.colorScheme === 'dark'
    ? 'dark'
    : 'light'

  const publish = (force = false) => {
    const colorScheme = currentScheme()
    if (!force && colorScheme === lastScheme) return
    lastScheme = colorScheme
    window.parent.postMessage({ type: themeType, colorScheme }, '*')
  }

  window.addEventListener('message', (event) => {
    if (event.source === window.parent && event.data?.type === requestType) publish(true)
  })

  const observer = new MutationObserver(() => publish())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  publish(true)
})()</script>`

/** sha1 content hash shortened to the same 12 hex chars used by Harness. */
function shortHash(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/** Resolve the nearest package root for one file-URL Loader entry. */
function packageRootOf(modulePath) {
  let current = dirname(modulePath)
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current || parse(current).root === current) return undefined
    current = parent
  }
}

/** Resolve a package's `./client` export in the forms supported by Harness. */
function clientExportOf(pkg) {
  const value = pkg.exports?.['./client']
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.default === 'string') {
    return value.default
  }
  return undefined
}

/**
 * Read standard `dsh.client` metadata for active plugins mounted by file URL.
 * Bare package entries remain owned by Harness's native package discovery.
 */
export function collectDesktopClientBundles(entries) {
  const bundles = new Map()
  for (const entry of entries) {
    const specifier = entry?.options?.name
    if (typeof specifier !== 'string' || !specifier.startsWith('file:')) continue

    const packageRoot = packageRootOf(fileURLToPath(specifier))
    if (packageRoot === undefined) continue
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    const declaration = pkg.dsh?.client
    if (declaration?.platform !== 'web') continue

    const clientExport = clientExportOf(pkg)
    if (clientExport === undefined) {
      throw new Error(`desktop-bridge: ${pkg.name} declares dsh.client but exports no ./client bundle`)
    }
    const clientPath = join(packageRoot, clientExport)
    const body = readFileSync(clientPath)
    const rev = shortHash(body)
    const routePath = `${CLIENT_BUNDLE_ROUTE_PREFIX}/${pkg.name}/client.js`
    const record = {
      body,
      routePath,
      entry: {
        id: pkg.name,
        url: `${routePath}?rev=${rev}`,
        rev,
        ...(declaration.inject !== undefined ? { inject: [...declaration.inject] } : {}),
        ...(declaration.immediately === true ? { immediately: true } : {}),
      },
    }
    const existing = bundles.get(pkg.name)
    if (existing !== undefined && existing.entry.rev !== record.entry.rev) {
      throw new Error(`desktop-bridge: conflicting file entries for client package ${pkg.name}`)
    }
    bundles.set(pkg.name, record)
  }
  return [...bundles.values()]
}

/** Inject the bootstrap theme bridge into one served HTML response. */
export function injectThemeBridge(html) {
  if (html.includes(THEME_BRIDGE_MARKER)) return html
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) throw new Error('Harness index.html has no opening <body> tag')
  const at = body.index + body[0].length
  return `${html.slice(0, at)}\n    ${THEME_BRIDGE_SCRIPT}${html.slice(at)}`
}

/**
 * Add a synchronous graph merge immediately before `</head>`. The Harness
 * shell is a deferred module script, while its standard boot manifest is
 * injected at the start of `<head>`; this ordering remains correct regardless
 * of which Host index tap registered first.
 */
export function injectDesktopClientBundles(html, bundles) {
  if (bundles.length === 0 || html.includes(CLIENT_BUNDLES_MARKER)) return html
  const headEnd = /<\/head>/i.exec(html)
  if (headEnd === null) throw new Error('desktop-bridge: Harness index.html has no closing </head> tag')

  const entries = bundles.map(bundle => bundle.entry)
  const rowsJson = JSON.stringify(entries).replaceAll('<', '\\u003c')
  const desktopRev = shortHash(JSON.stringify(entries))
  const script = `<script ${CLIENT_BUNDLES_MARKER}>(() => {\n`
    + `  const graph = window.__DSH_BOOT__\n`
    + `  if (!graph || !Array.isArray(graph.entries) || typeof graph.rev !== 'string') {\n`
    + `    throw new Error('desktop-bridge: Harness boot manifest is unavailable')\n`
    + `  }\n`
    + `  const known = new Set(graph.entries.map(row => row && row.id))\n`
    + `  let changed = false\n`
    + `  for (const row of ${rowsJson}) {\n`
    + `    if (known.has(row.id)) continue\n`
    + `    graph.entries.push(row)\n`
    + `    known.add(row.id)\n`
    + `    changed = true\n`
    + `  }\n`
    + `  if (changed) graph.rev += '-desktop-${desktopRev}'\n`
    + `})()</script>`
  return `${html.slice(0, headEnd.index)}  ${script}\n${html.slice(headEnd.index)}`
}

/** Serve one immutable-in-process browser bundle. */
function serveBundle(bundle, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': bundle.body.byteLength,
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : bundle.body)
}

/** Resolve and serve one bundle from the Loader's current file-mounted entries. */
function serveDiscoveredBundle(bundles, req, res) {
  const pathname = new URL(req.url ?? '/', 'http://desktop.local').pathname
  const bundle = bundles.find(candidate => candidate.routePath === pathname)
  if (bundle === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  serveBundle(bundle, req, res)
}

/** Mount the theme synchronization and the Desktop-only package resolver. */
export function apply(ctx) {
  // Loader mounts sibling rows concurrently. Resolve the file-mounted package
  // table when HTTP actually asks for the index or a bundle, after startup has
  // settled, instead of snapshotting whichever rows happened to exist while
  // desktop-bridge itself was activating.
  const bundles = () => collectDesktopClientBundles(ctx.loader.entries())
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: CLIENT_BUNDLE_ROUTE_PREFIX,
      handler: (req, res) => serveDiscoveredBundle(bundles(), req, res),
    }),
    'desktop-bridge: browser bundle routes',
  )
  ctx.effect(
    () => ctx.webServer.tapIndex(html => injectDesktopClientBundles(html, bundles())),
    'desktop-bridge: file-mounted client bundle discovery',
  )
  ctx.effect(
    () => ctx.webServer.tapIndex(injectThemeBridge),
    'desktop-bridge: initial theme synchronization',
  )
}
