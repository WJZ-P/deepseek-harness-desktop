import type { ReactNode } from 'react'

/** One model row exposed to additive settings-field plugins. */
export interface ModelFieldOwnerProps {
  /** Current draft, including fields the built-in editor does not render. */
  model: Readonly<Record<string, unknown>>
  /** Zero-based position in the provider profile's `models` array. */
  index: number
  /** Whether the owning provider editor currently accepts changes. */
  disabled: boolean
  /** Merge fields into this row; `undefined` removes the addressed field. */
  update: (patch: Readonly<Record<string, unknown>>) => void
}

/** Delegated child-slot renderer passed through the provider form. */
export type ModelFieldRenderer = (owner: ModelFieldOwnerProps) => ReactNode

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Additive fields inside one pi-ai model row's advanced disclosure.
     * The owner passes the complete open draft and a row-local patch callback,
     * so a feature can edit an adapter-supported model property without
     * replacing the Models page or importing its implementation. Entries
     * render by ascending `order`.
     */
    'settings.models.model.fields': { kind: 'list'; scope: 'root'; owner: ModelFieldOwnerProps }
  }
}
