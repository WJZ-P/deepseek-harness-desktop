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
3. Readiness parsing and navigation to the assigned loopback origin.
4. A small launch/error screen.

Agent behavior, tools, RPC methods, persistence, workspace access, and client composition remain implemented by Harness plugins rather than a parallel desktop implementation.

## Follow-up packaging seam

The development launcher uses the installed Node executable plus the built vendored checkout. A self-contained release should preserve the same process protocol (`stdout` readiness, loopback HTTP/WebSocket, process-tree teardown) while replacing the command resolver with a Tauri `externalBin` sidecar. This keeps packaging separate from runtime architecture.
