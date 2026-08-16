# Architecture notes

## Upstream findings

DeepSeek Harness is a Cordis plugin composition. `dsh-base` provides the capability spine, while `dsh-web-app` adds the Host web server, API gateway, persistent storage, browser plugin roster, and the built frontend. A profile is an ordered bundle stack plus user patch layers.

The Web UI is not a standalone Vite application. The Host injects `window.__DSH_BOOT__`, which describes the active client plugin graph. The browser connection package uses HTTP POST for unary calls and two downlink WebSockets for multiplexed and Host events. Session logs remain the durable source for replay and model-visible context.

For that reason, copying only `apps/web/dist` into Tauri would produce an incomplete shell: it would omit the runtime boot manifest and Host transport. The desktop wrapper supervises the complete `web` profile from the repository's `harness/` source tree and embeds its loopback URL.

## Source ownership

The desktop repository tracks the complete `harness/` tree as ordinary Git files. A normal clone therefore includes the matching Harness sources without submodule initialization or another repository checkout. [`HARNESS_UPSTREAM.md`](HARNESS_UPSTREAM.md) records the exact upstream URL, commit, and license provenance for the flattened import.

Dependency directories and generated output remain ignored. `scripts/prepare-harness.mjs` validates source presence, installs from the vendored lockfile when needed, and builds the launcher and browser assets before Tauri development or frontend builds. `scripts/prepare-external-plugins.mjs` independently resolves the public plugin repositories at the exact commits in `external-plugins.json`. `DEEPSEEK_HARNESS_ROOT` remains an explicit developer override; normal startup resolves the in-repository source tree.

## Desktop ownership

The desktop repository owns:

1. Native application/window lifecycle.
2. Preparation and supervision of the vendored Harness runtime.
3. Readiness parsing and mounting of the assigned loopback origin inside the persistent desktop shell.
4. A frameless titlebar plus theme-aware launch/error presentation.
5. Desktop-only Cordis plugins under `desktop-plugins/`.
6. Commit-locked integration of external, product-neutral DSH plugin repositories.

Agent behavior, tools, RPC methods, persistence, workspace access, and the normal client composition remain implemented by Harness rather than a parallel desktop implementation. Public plugins use Harness's existing `dsh.client` package discovery and `/plugins` transport when installed in native DSH. Desktop mounts their Host entries by absolute file URL; its private bridge reads the same package manifests and exposes those prebuilt browser artifacts under a Desktop-only route prefix, without adding a Desktop branch to the public packages. The vendored tree carries only product-neutral UI seams: `conversation.input.attachments` lets attachment plugins place cards in the native composer attachment rail, and `settings.models.model.fields` lets a plugin edit one model draft through the native Models page. Desktop behavior does not import or patch private React components.

The Tauri WebView remains on the packaged desktop origin so the custom titlebar survives application startup. After the Host reports readiness, the shell loads the loopback Web UI in a full-size iframe below that titlebar. The frame is restricted to the Rust-validated `http://127.0.0.1:<port>` origin, while the embedded application continues to own its HTTP and WebSocket transports. On every launch Rust writes a temporary `--patch` overlay containing three independent plugins:

- `desktop-bridge` uses the Host's `tapIndex` response transform to add an idempotent theme bootstrap at request time. It also discovers active file-URL Loader entries with a standard Web `dsh.client` declaration, serves their exported client bundles from exact `/desktop-plugin-bundles/...` routes, and merges the matching rows into `window.__DSH_BOOT__` before the shell parses it. Harness's generated HTML stays untouched, while native installations continue through ordinary package discovery. The parent validates both the iframe window and loopback origin before applying the reported scheme to its `body[data-ds-dark-theme]` token palette; Tauri window theme events remain the launch-time fallback.
- [`dsh-attachments`](https://github.com/WJZ-P/dsh-attachments) is an external installable DSH bundle, not a desktop package. Its package manifest declares both `dsh.bundle` and Web `dsh.client`; `cordis.patch.yml` mounts the Host entry and standard client discovery serves its exported browser bundle. It leaves PNG/JPEG/WebP/GIF on Harness's native draft-image, durable attachment, gallery, and lightbox path. Tauri's native file-drop interception is disabled so the iframe receives ordinary HTML5 file events. The plugin captures non-image files from mixed or file-only drops. One HTML5 directory entry remains one logical attachment: its descendants are streamed into a private directory tree with bounded concurrency, but never become separate composer/history cards. It contributes those cards through public slots and Conversation Definitions, adds only a dashed outline above Harness's native drag mask, and decorates the next admitted user message with durable attachment metadata. Before a model step, it copies each file or complete folder tree into the active workspace's `.deepseek-harness/attachments/` directory and refreshes the model-visible locator. Queue edits transfer ownership synchronously; cancellation and plugin disposal retire uncommitted object bytes.
- [`dsh-model-capabilities`](https://github.com/WJZ-P/dsh-model-capabilities) is an external standard installable DSH bundle. Its `dsh.client` declaration contributes an Input Modalities selector to each pi-ai model row through standard package discovery. It edits the open model draft through the slot owner's patch callback, while the native Models page retains provider validation, settings revisions, and persistence. It has its own `dsh.bundle` manifest, patch layer, build, tests, package allowlist, README, lockfile, CI, and license, and does not depend on Tauri.

This split is deliberate: titlebar/theme integration, conversation attachments, and model-capability presentation can evolve, fail, or be removed independently, while updating the upstream Harness snapshot touches only small, product-neutral extension points.

## Release packaging

Development always uses the freshly prepared vendored checkout, even when older release resources remain under `target/debug`. Every platform Release build first resolves the public plugins from their independent repositories at the commits in `external-plugins.json`, then deploys the CLI production closure, materializes workspace peer packages, stages the Desktop-only bridge and locked external bundles, adds the native Node executable, and stores the expanded Harness tree as a Tauri resource. Windows publishes a portable ZIP, Linux publishes AppImage and DEB bundles, and macOS publishes architecture-specific DMGs. The packaged process executes `runtime/harness/lib/bin.js` directly beside the embedded Node runtime, so startup does not unpack or copy a second runtime tree into the application's local data directory.

Both modes preserve the same process protocol: `stdout` readiness, a random loopback HTTP/WebSocket origin, and process-tree teardown. The packaged resolver is therefore a distribution change rather than a second runtime architecture.
