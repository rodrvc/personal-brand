/** Tests for the shared clip file name (fictional card ids only). Run: node core/test/clips.test.mjs */
import assert from 'node:assert/strict'

import { clipFileName } from '../src/clips.js'

assert.equal(clipFileName(0, 'cover', 3), '0-cover.mp4')
assert.equal(clipFileName(9, 'item', 10), '9-item.mp4', 'ten cards: the last index is 9, one digit')
assert.equal(clipFileName(1, 'item', 11), '01-item.mp4', 'eleven cards: the last index is 10, two digits')
assert.equal(clipFileName(10, 'item', 11), '10-item.mp4')
console.log('clips: ok')
