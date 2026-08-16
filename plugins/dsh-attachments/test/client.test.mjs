import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const clientPath = join(import.meta.dirname, '..', 'lib', 'client.js')

let registered
globalThis.window = {
  __ModuleLoader__: {
    load(row) {
      registered = row
    },
  },
}

await import(`${pathToFileURL(clientPath).href}?client-test=${Date.now()}`)
assert.equal(registered?.id, 'dsh-attachments')
const client = registered.factory((specifier) => {
  if (specifier === 'react') {
    return {
      memo: component => component,
      useCallback: () => { throw new Error('hook not exercised by bundle contract test') },
      useEffect: () => { throw new Error('hook not exercised by bundle contract test') },
      useRef: () => { throw new Error('hook not exercised by bundle contract test') },
      useState: () => { throw new Error('hook not exercised by bundle contract test') },
      useSyncExternalStore: () => { throw new Error('hook not exercised by bundle contract test') },
    }
  }
  if (specifier === 'react/jsx-runtime') {
    return {
      Fragment: Symbol.for('react.fragment'),
      jsx: () => { throw new Error('component rendering is outside this registry contract test') },
      jsxs: () => { throw new Error('component rendering is outside this registry contract test') },
    }
  }
  throw new Error(`unexpected browser external: ${specifier}`)
})

test('browser bundle partitions native images from generic attachment files', () => {
  const png = { name: 'whale.png', type: 'image/png' }
  const svg = { name: 'whale.svg', type: 'image/svg+xml' }
  const text = { name: 'notes.txt', type: 'text/plain' }
  const partition = client.internals.partitionDroppedFiles([png, svg, text])

  assert.deepEqual(partition.nativeImages, [png])
  assert.deepEqual(partition.genericFiles, [svg, text])
})

test('browser bundle registers input cards and history renderer through public slots', () => {
  const slots = []
  const definitions = []
  const effects = []
  const ctx = {
    effect(callback, label) {
      effects.push({ callback, label })
    },
    conversationEvents: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(name, mount) {
        slots.push({ kind: 'inject', name })
        mount()
        return () => {}
      },
      register(options, component) {
        slots.push({ kind: 'register', options, component })
        return () => {}
      },
    },
  }

  client.apply(ctx)

  assert.deepEqual(
    slots.filter(row => row.kind === 'register').map(row => row.options.name),
    ['conversation.chat.node', 'conversation.input.attachments'],
  )
  assert.equal(definitions[0]?.kind, 'dsh-attachments')
  assert.match(effects[0]?.label, /styles/)
})

test('a dropped folder remains one logical attachment instead of one card per child', async () => {
  const text = { name: 'notes.txt', type: 'text/plain', size: 5, webkitRelativePath: '' }
  const image = { name: 'whale.png', type: 'image/png', size: 8, webkitRelativePath: '' }
  const fileEntry = file => ({
    isFile: true,
    isDirectory: false,
    name: file.name,
    file(resolve) { resolve(file) },
  })
  const directoryEntry = (name, batches) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let index = 0
      return {
        readEntries(resolve) { resolve(batches[index++] ?? []) },
      }
    },
  })
  const nested = directoryEntry('assets', [[fileEntry(image)], []])
  const root = directoryEntry('project', [[fileEntry(text)], [nested], []])

  const collected = await client.internals.collectDrop([{ entry: root, file: null }])

  assert.equal(collected.errors.length, 0)
  assert.equal(collected.sources.length, 1)
  assert.equal(collected.sources[0].kind, 'directory')
  assert.equal(collected.sources[0].name, 'project')
  assert.equal(collected.sources[0].entry, root)

  const members = await client.internals.directoryMembers(root)

  assert.deepEqual(members.map(row => [row.kind, row.path]), [
    ['file', 'notes.txt'],
    ['directory', 'assets'],
    ['file', 'assets/whale.png'],
  ])
  assert.deepEqual(members.filter(row => row.kind === 'file').map(row => row.file), [text, image])
})

test('the plugin owns directory and generic-file drops but leaves direct native images to Harness', () => {
  const directory = { isDirectory: true, isFile: false, name: 'project' }
  const png = { name: 'whale.png', type: 'image/png' }
  const text = { name: 'notes.txt', type: 'text/plain' }

  assert.equal(client.internals.pluginOwnsDrop([{ entry: directory, file: null }]), true)
  assert.equal(client.internals.pluginOwnsDrop([{ entry: null, file: text }]), true)
  assert.equal(client.internals.pluginOwnsDrop([{ entry: null, file: png }]), false)
})

test('history definition projects durable attachment metadata into a chat node', () => {
  const file = {
    id: '22df9452-b27e-4ca5-a6a6-69bb99b95fee',
    kind: 'file',
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 12,
    path: '.deepseek-harness/attachments/22df9452-notes.txt',
  }
  const event = {
    type: 'user/message',
    seq: 7,
    time: 123,
    data: {
      id: 'message-1',
      source: { kind: 'user', dshAttachments: [file] },
    },
  }
  const definition = client.internals.attachmentDefinition
  const match = definition.match(event)
  assert.deepEqual(match, { id: 'message-1', role: 'start' })

  const state = definition.start({}, { ...match, event })
  const node = definition.buildViewNode({
    key: 'dsh-attachments:message-1',
    id: 'message-1',
    state,
    start: { location: { kind: 'turn', turn: 1 } },
  })
  assert.equal(node.kind, 'dsh-attachments')
  assert.equal(node.anchorSeq, 7.01)
  assert.deepEqual(node.data.files, [file])
})
