/** dsh-model-capabilities browser half. */

const CLIENT_BUNDLE_ID = 'dsh-model-capabilities'
const NS = 'dsh-model-capabilities'

const en = {
  label: 'Input modalities',
  hint: 'Used by Harness to validate attachments before sending.',
  inherit: 'Inherit provider default',
  text: 'Text',
  image: 'Image',
  textImage: 'Text + image',
}

const zh = {
  label: '输入类型',
  hint: '用于 Harness 在发送附件前判断模型能力。',
  inherit: '继承提供方默认值',
  text: '文本',
  image: '图片',
  textImage: '文本 + 图片',
}

type CopyKey = keyof typeof en
type InputSelection = 'inherit' | 'text' | 'image' | 'text-image'

interface ModelFieldProps {
  model: Readonly<Record<string, unknown>>
  index: number
  disabled: boolean
  update: (patch: Readonly<Record<string, unknown>>) => void
  t: (key: CopyKey) => string
}

/** Convert a stored modality list into the select's stable value. */
function selectionOf(value: unknown): InputSelection {
  if (!Array.isArray(value) || value.length === 0) return 'inherit'
  const text = value.includes('text')
  const image = value.includes('image')
  if (text && image) return 'text-image'
  if (image) return 'image'
  if (text) return 'text'
  return 'inherit'
}

/** Convert one select value into a model-row patch. */
function patchForSelection(selection: InputSelection): Readonly<Record<string, unknown>> {
  switch (selection) {
    case 'inherit': return { input: undefined }
    case 'text': return { input: ['text'] }
    case 'image': return { input: ['image'] }
    case 'text-image': return { input: ['text', 'image'] }
  }
}

/** Model-level input modality field rendered inside the native advanced row. */
function ModelInputField({ model, index, disabled, update, t }: ModelFieldProps) {
  return (
    <label className="dsh-model-capabilities-field">
      <span className="dsh-model-capabilities-copy">
        <span className="dsh-model-capabilities-label">{t('label')}</span>
        <span className="dsh-model-capabilities-hint">{t('hint')}</span>
      </span>
      <span className="dsh-model-capabilities-select-wrap">
        <select
          className="dsh-model-capabilities-select"
          value={selectionOf(model.input)}
          aria-label={`${t('label')} ${String(index + 1)}`}
          disabled={disabled}
          onChange={(event) => { update(patchForSelection(event.target.value as InputSelection)) }}
        >
          <option value="inherit">{t('inherit')}</option>
          <option value="text">{t('text')}</option>
          <option value="text-image">{t('textImage')}</option>
          <option value="image">{t('image')}</option>
        </select>
      </span>
    </label>
  )
}

const STYLES = `
.dsh-model-capabilities-field{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:0;padding:8px 0 0;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-model-capabilities-copy{display:flex;flex:1 1 auto;min-width:0;flex-direction:column;gap:1px}.dsh-model-capabilities-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:500}.dsh-model-capabilities-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-model-capabilities-select-wrap{position:relative;flex:0 1 220px;min-width:160px}.dsh-model-capabilities-select{box-sizing:border-box;width:100%;height:32px;padding:0 32px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;appearance:none;background-color:var(--dsw-alias-bg-layer-1);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsh-model-capabilities-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}.dsh-model-capabilities-select:disabled{cursor:default;opacity:.6}
@media(max-width:560px){.dsh-model-capabilities-field{align-items:stretch;flex-direction:column;gap:6px}.dsh-model-capabilities-select-wrap{flex-basis:auto;width:100%}}
`

function installStyles(): () => void {
  const existing = document.querySelector(`style[data-plugin="${CLIENT_BUNDLE_ID}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = CLIENT_BUNDLE_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

export const inject = ['slots', 'locale']

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-model-capabilities: dictionaries')
  ctx.effect(installStyles, 'dsh-model-capabilities: styles')
  ctx.slots.inject('settings.models.model.fields', () => ctx.slots.register({
    name: 'settings.models.model.fields',
    id: 'input-modalities',
    order: 0,
    locale: NS,
  }, ModelInputField))
}

export const internals = { selectionOf, patchForSelection }
