import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const clientPath = join(import.meta.dirname, '..', 'lib', 'client.js')

let registered
globalThis.window = {
  __ModuleLoader__: {
    load(row) { registered = row },
  },
}

await import(`${pathToFileURL(clientPath).href}?client-test=${Date.now()}`)
assert.equal(registered?.id, 'dsh-model-capabilities')

const element = (type, props) => ({ type, props: props ?? {} })
const client = registered.factory((specifier) => {
  if (specifier === 'react/jsx-runtime') {
    return { Fragment: Symbol.for('react.fragment'), jsx: element, jsxs: element }
  }
  throw new Error(`unexpected browser external: ${specifier}`)
})

test('browser half maps every supported input declaration', () => {
  const { selectionOf, patchForSelection } = client.internals
  assert.equal(selectionOf(undefined), 'inherit')
  assert.equal(selectionOf([]), 'inherit')
  assert.equal(selectionOf(['text']), 'text')
  assert.equal(selectionOf(['image']), 'image')
  assert.equal(selectionOf(['image', 'text']), 'text-image')
  assert.deepEqual(patchForSelection('inherit'), { input: undefined })
  assert.deepEqual(patchForSelection('text'), { input: ['text'] })
  assert.deepEqual(patchForSelection('image'), { input: ['image'] })
  assert.deepEqual(patchForSelection('text-image'), { input: ['text', 'image'] })
})

test('browser half registers one localized additive model field', () => {
  const rows = []
  const effects = []
  const ctx = {
    effect(callback, label) { effects.push({ callback, label }) },
    locale: { register() { return () => {} } },
    slots: {
      inject(name, mount) {
        rows.push({ kind: 'inject', name })
        mount()
        return () => {}
      },
      register(options, component) {
        rows.push({ kind: 'register', options, component })
        return () => {}
      },
    },
  }

  client.apply(ctx)

  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.deepEqual(rows[0], { kind: 'inject', name: 'settings.models.model.fields' })
  assert.deepEqual(rows[1].options, {
    name: 'settings.models.model.fields',
    id: 'input-modalities',
    order: 0,
    locale: 'dsh-model-capabilities',
  })
  assert.deepEqual(effects.map(row => row.label), [
    'dsh-model-capabilities: dictionaries',
    'dsh-model-capabilities: styles',
  ])

  const updates = []
  const view = rows[1].component({
    model: { id: 'glm', input: ['text', 'image'] },
    index: 2,
    disabled: false,
    update: patch => { updates.push(patch) },
    t: key => key,
  })
  const selectWrap = view.props.children[1]
  const select = selectWrap.props.children
  assert.equal(select.type, 'select')
  assert.equal(select.props.value, 'text-image')
  assert.equal(select.props['aria-label'], 'label 3')
  select.props.onChange({ target: { value: 'text' } })
  assert.deepEqual(updates, [{ input: ['text'] }])
})
