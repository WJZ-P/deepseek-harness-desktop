# Vendored DeepSeek Harness

The complete Harness source tree is stored in [`harness/`](harness/) as ordinary files tracked by this repository. It is not a Git submodule.

- Upstream: `https://github.com/deepseek-ai/deepseek-harness.git`
- Imported commit: `47f943859bef60e4160492346772ded9b24f765a`
- Upstream license: MIT; the original notice remains at [`harness/LICENSE`](harness/LICENSE).

The commit above is the imported baseline. Public packages use Harness's existing `dsh.client` discovery path. The desktop repository carries two deliberately small, product-neutral UI integration seams over it:

- `packages/client/ui-conversation` declares and renders `conversation.input.attachments`, a list slot inside the native composer attachment rail;
- `packages/client/ui-attachment` accepts those product-neutral tail cards in `AttachmentRail` and keeps scroll-edge state current as cards change.
- `packages/client/ui-settings-models` declares and renders `settings.models.model.fields`, an additive slot over one pi-ai model draft; the native page keeps ownership of validation and persistence.
- `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` is regenerated from that public slot contract so native DSH plugins can discover it.

Only the Tauri integration bridge remains under [`desktop-plugins/`](desktop-plugins/): it synchronizes themes and retains a `dsh.client` adapter for explicitly file-mounted development entries. Preinstalled public plugins are staged into the Desktop runtime's package resolver and mounted by their declared package names, so the same ordinary `dsh.client` boot graph and `/plugins` transport used by native DSH also serve Desktop. Attachment storage, drag/drop UI, input previews, and history rendering ship from the independent [`dsh-attachments`](https://github.com/WJZ-P/dsh-attachments) repository; the Input Modalities control ships from [`dsh-model-capabilities`](https://github.com/WJZ-P/dsh-model-capabilities). The desktop repository records only their source URLs and exact commits in [`external-plugins.json`](external-plugins.json); its local `plugins/` checkout directory is ignored. Both packages follow the native DSH bundle format and can be installed without Desktop. None of those product implementations live in vendored Harness business packages.

When updating, replace `harness/` with the tracked tree from one reviewed upstream commit, update the commit above in the same change, then reapply this seam only if upstream has no equivalent public API. Generated directories such as `node_modules/`, `lib/`, and `dist/` remain ignored; `pnpm run harness:prepare` recreates them from the checked-in lockfile.
