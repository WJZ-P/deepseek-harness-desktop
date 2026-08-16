# Marketplace submission notes

This file tracks the current `awesome-dsh-plugin` / `dsh-market` submission contract for the `dsh-attachments` monorepo package.

## Catalog data file

The catalog READMEs are generated. Copy the checked-in fixture
[`marketplace/WJZ-P__deepseek-harness-desktop--plugins-dsh-attachments.yml`](marketplace/WJZ-P__deepseek-harness-desktop--plugins-dsh-attachments.yml)
to this path in an `awesome-dsh-plugin` checkout:

```text
data/plugins/WJZ-P__deepseek-harness-desktop--plugins-dsh-attachments.yml
```

Its category is `ui`, rendered as **UI Enhancements / UI 增强**. The entry URL points directly to this monorepo subpackage, and its display name follows the catalog's `owner/repo#subname` convention.

After copying the file, regenerate the catalog output as required upstream:

```sh
npm ci
node scripts/generate-readme.mjs
```

Commit the new YAML file, both generated README changes, and the screenshot
registry change in the catalog PR.

## Screenshot registry entry

The reviewed screenshot snippet is checked in at [`marketplace/screenshots.entry.json`](marketplace/screenshots.entry.json). Merge that object into the catalog's `data/screenshots.json`, using the YAML entry's exact `url` as the key:

```json
{
  "https://github.com/WJZ-P/deepseek-harness-desktop/tree/main/plugins/dsh-attachments": [
    "https://raw.githubusercontent.com/WJZ-P/deepseek-harness-desktop/main/plugins/dsh-attachments/assets/screenshots/01-drag-drop-overlay.png",
    "https://raw.githubusercontent.com/WJZ-P/deepseek-harness-desktop/main/plugins/dsh-attachments/assets/screenshots/02-image-conversation.png",
    "https://raw.githubusercontent.com/WJZ-P/deepseek-harness-desktop/main/plugins/dsh-attachments/assets/screenshots/03-multiple-image-preview.png"
  ]
}
```

All three files use GitHub-hosted PNG URLs and preserve the intended storefront order.

## Submission checklist

- [x] Subpackage declares `dsh.bundle.patch`.
- [x] Browser UI declares `dsh.client.platform: web` and exports `./client`.
- [x] `cordis.patch.yml` inserts the package Host row.
- [x] Official `@deepseek-ai/*` compatibility packages are peer dependencies.
- [x] npm package allowlist contains prebuilt Host and browser artifacts.
- [x] English and Chinese plugin documentation is present.
- [x] Catalog YAML uses the monorepo subpackage URL, `ui` category, and factual bilingual descriptions.
- [x] Repository is older than one day and currently has at least ten commits.
- [x] Avoid advertising the unrelated unscoped `dsh-attachments` npm package; use the GitHub subpackage install spec.
- [ ] Select a distinct npm registry name and publish the prebuilt package (recommended, not required for the catalog PR).
- [ ] Add the `dsh-plugin` topic to `WJZ-P/deepseek-harness-desktop` on GitHub.
- [x] Add and review 1-8 screenshots from `assets/screenshots/`.
- [x] Rehearse README generation, `awesome-lint`, and the storefront build against a fresh catalog checkout.
- [ ] Open the catalog PR with the YAML file, regenerated READMEs, and optional screenshot JSON entry.
