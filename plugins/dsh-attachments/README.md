# dsh-attachments

English | [中文](README.zh.md)

`dsh-attachments` adds file and folder attachments to the DeepSeek Harness Web UI. Images continue through Harness's native image pipeline; the plugin handles generic files and complete directory trees.

## Features

- Drop ordinary files, images, or folders from the operating system.
- Keep native PNG/JPEG/WebP/GIF preview, history gallery, and model-capability checks.
- Represent one dropped folder as one attachment card while preserving its directory tree.
- Copy committed files and folders into `.deepseek-harness/attachments/` in the active workspace before the model step.
- Render attachment cards in both the composer and persistent message history.
- Stream upload and download bytes without adding plugin-defined file-count or per-file-size limits.
- Leave the original composer layout unchanged while no plugin-owned attachment is present.

## Screenshots

### Drag-and-drop surface

The plugin adds its window-level dashed drop boundary while preserving Harness's native image-intake surface.

![Drag-and-drop attachment surface](assets/screenshots/01-drag-drop-overlay.png)

### Image conversation history

Native image messages continue to render in persistent conversation history and remain available to multimodal models.

![Image message and model response](assets/screenshots/02-image-conversation.png)

### Multiple image previews

Multiple native image previews share the composer attachment rail used by plugin-provided file and folder cards.

![Multiple image previews in one prompt](assets/screenshots/03-multiple-image-preview.png)

## Install

Install the current monorepo subpackage directly from GitHub into a native DSH
`web` profile:

```sh
dsh plugin --profile web add github:WJZ-P/deepseek-harness-desktop#path:/plugins/dsh-attachments
```

This explicit source is intentional: the unscoped `dsh-attachments` name on npm
belongs to a different project. The marketplace also uses the GitHub subpackage
form until this plugin has its own registry package.

Build and install this monorepo checkout from the repository root:

```sh
pnpm install
pnpm run plugin:build
dsh plugin --profile web add ./plugins/dsh-attachments
```

Or run these commands inside this package directory:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

Inspect the composed profile and start DSH:

```sh
dsh --profile web --dump-config
dsh --profile web
```

Remove the plugin:

```sh
dsh plugin --profile web remove dsh-attachments
```

## DSH package contract

This package follows the installable DSH bundle format:

- `dsh.bundle.patch` points to `cordis.patch.yml`, which inserts the Host plugin row.
- `dsh.client.platform` is `web`, and `exports["./client"]` exposes the prebuilt browser bundle.
- Official `@deepseek-ai/*` compatibility packages are declared as peer dependencies.
- The npm tarball contains prebuilt `lib/` artifacts, so registry installs do not need to build the browser bundle.

The Host half owns byte transport, durable metadata, and workspace materialization. The browser half contributes composer and history UI through Harness extension slots. The package has no Tauri runtime dependency.

## Compatibility

The current release targets the interfaces in DeepSeek Harness `0.1.0-rc.5`: standard bundle loading, web client discovery, conversation input/history slots, session events, and Host route registration.

## Development

```sh
pnpm install
pnpm run build
pnpm test
npm pack --dry-run
```

The ready-to-copy catalog YAML and screenshot URL template are maintained in [MARKETPLACE.md](https://github.com/WJZ-P/deepseek-harness-desktop/blob/main/plugins/dsh-attachments/MARKETPLACE.md). Screenshot files belong in [`assets/screenshots/`](https://github.com/WJZ-P/deepseek-harness-desktop/tree/main/plugins/dsh-attachments/assets/screenshots).

## License

[MIT](LICENSE)
