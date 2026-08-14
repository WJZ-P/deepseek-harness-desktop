# Architecture notes

## Upstream findings

DeepSeek Harness is a Cordis plugin composition. `dsh-base` provides the capability spine, while `dsh-web-app` adds the Host web server, API gateway, persistent storage, browser plugin roster, and the built frontend. A profile is an ordered bundle stack plus user patch layers.

The Web UI is not a standalone Vite application. The Host injects `window.__DSH_BOOT__`, which describes the active client plugin graph. The browser connection package uses HTTP POST for unary calls and two downlink WebSockets for multiplexed and Host events. Session logs remain the durable source for replay and model-visible context.

For that reason, copying only `apps/web/dist` into Tauri would produce an incomplete shell: it would omit the runtime boot manifest and Host transport. The desktop wrapper supervises the complete `web` profile from the repository's `harness/` source tree and embeds its loopback URL.

## Source ownership

The desktop repository tracks the complete `harness/` tree as ordinary Git files. A normal clone therefore includes the matching Harness sources without submodule initialization or another repository checkout. [`HARNESS_UPSTREAM.md`](HARNESS_UPSTREAM.md) records the exact upstream URL, commit, and license provenance for the flattened import.

Dependency directories and generated output remain ignored. `scripts/prepare-harness.mjs` validates source presence, installs from the vendored lockfile when needed, and builds the launcher and browser assets before Tauri development or frontend builds. `DEEPSEEK_HARNESS_ROOT` remains an explicit developer override; normal startup resolves the in-repository source tree.

## Desktop ownership

The desktop repository adds only:

1. Native application/window lifecycle.
2. Preparation and supervision of the vendored Harness runtime.
3. Readiness parsing and mounting of the assigned loopback origin inside the persistent desktop shell.
4. A frameless titlebar plus theme-aware launch/error presentation.

Agent behavior, tools, RPC methods, persistence, workspace access, and client composition remain implemented by Harness plugins rather than a parallel desktop implementation.

The Tauri WebView remains on the packaged desktop origin so the custom titlebar survives application startup. After the Host reports readiness, the shell loads the loopback Web UI in a full-size iframe below that titlebar. The frame is restricted to the Rust-validated `http://127.0.0.1:<port>` origin, while the embedded application continues to own its HTTP and WebSocket transports. During `harness:prepare`, the generated Harness HTML receives an idempotent desktop bridge that reports its resolved light/dark color scheme to the parent. The parent validates both the iframe window and loopback origin before applying that scheme to its `body[data-ds-dark-theme]` token palette, so the 32px titlebar follows Harness's live Appearance setting; Tauri window theme events remain the launch-time fallback.

## Release packaging

Development always uses the freshly prepared vendored checkout, even when an older release archive remains under `target/debug`. The Windows Release build deploys the CLI production closure, materializes workspace peer packages, stages a supported `node.exe` beside the Tauri executable, and stores the Harness tree as a compressed runtime resource. The release artifact is a portable ZIP rather than an installer. First launch extracts the versioned tree under the application's local data directory; subsequent launches reuse it.

Both modes preserve the same process protocol: `stdout` readiness, a random loopback HTTP/WebSocket origin, and process-tree teardown. The packaged resolver is therefore a distribution change rather than a second runtime architecture.
