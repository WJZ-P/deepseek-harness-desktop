import { readFile, writeFile } from "node:fs/promises";

export const DESKTOP_THEME_BRIDGE_MARKER = "data-dsh-desktop-theme-bridge";

const DESKTOP_THEME_BRIDGE = `<script ${DESKTOP_THEME_BRIDGE_MARKER}>(() => {
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
})()</script>`;

export function injectDesktopThemeBridge(html) {
  if (html.includes(DESKTOP_THEME_BRIDGE_MARKER)) return html;

  const body = /<body(?:\s[^>]*)?>/i.exec(html);
  if (body === null) {
    throw new Error("Harness index.html has no opening <body> tag");
  }

  const at = body.index + body[0].length;
  return `${html.slice(0, at)}\n    ${DESKTOP_THEME_BRIDGE}${html.slice(at)}`;
}

export async function installDesktopThemeBridge(indexPath) {
  const source = await readFile(indexPath, "utf8");
  const patched = injectDesktopThemeBridge(source);
  if (patched !== source) {
    await writeFile(indexPath, patched, "utf8");
    console.log("[harness] Installed desktop theme bridge.");
  } else {
    console.log("[harness] Desktop theme bridge is ready.");
  }
}
