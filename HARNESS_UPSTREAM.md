# Vendored DeepSeek Harness

The complete Harness source tree is stored in [`harness/`](harness/) as ordinary files tracked by this repository. It is not a Git submodule.

- Upstream: `https://github.com/deepseek-ai/deepseek-harness.git`
- Imported commit: `47f943859bef60e4160492346772ded9b24f765a`
- Upstream license: MIT; the original notice remains at [`harness/LICENSE`](harness/LICENSE).

Keeping the exact upstream commit here makes the flattened source import auditable. When updating, replace `harness/` with the tracked tree from one reviewed upstream commit, update the commit above in the same change, and run the desktop and Harness checks that cover the update. Generated directories such as `node_modules/`, `lib/`, and `dist/` remain ignored; `pnpm run harness:prepare` recreates them from the checked-in lockfile.
