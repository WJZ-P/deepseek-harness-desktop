import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../src/index.mjs'

test('host entry leaves browser discovery to the dsh.client manifest', () => {
  assert.equal(name, 'dsh-model-capabilities')
  assert.doesNotThrow(() => apply())
})
