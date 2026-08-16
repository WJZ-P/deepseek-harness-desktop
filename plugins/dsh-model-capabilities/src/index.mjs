/**
 * dsh-model-capabilities, Host half.
 *
 * This standard DSH bundle lives outside the vendored `harness/` tree and can
 * be installed into any compatible web profile through its `dsh.bundle`
 * manifest. Its dsh.client declaration contributes the browser-only model
 * field through Harness's standard package discovery. Provider persistence
 * remains in the Models page, which owns the complete draft and mutation.
 */

export const name = 'dsh-model-capabilities'

/** Host Loader entry; dsh.client owns browser discovery and ordering. */
export function apply() {}
