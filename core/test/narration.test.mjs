/** Tests for the shared narration hash (fictional voice only). Run: node core/test/narration.test.mjs */
import assert from 'node:assert/strict'

import { effectiveVoice, narrationCacheKey, normaliseNarration } from '../src/narration.js'

const voice = { voice_id: 'voice-1' }

assert.equal(normaliseNarration('  one \n two\t three '), 'one two three')
assert.equal(narrationCacheKey('one  two', voice), narrationCacheKey('one\ntwo', voice), 'reflowed text hashes the same')
assert.notEqual(narrationCacheKey('one two', voice), narrationCacheKey('one two', { ...voice, speed: 1.1 }), 'a voice setting changes the hash')
assert.equal(narrationCacheKey('one', voice), narrationCacheKey('one', { ...voice, model_id: 'eleven_multilingual_v2', stability: 0.5, speed: 1 }), 'defaults are part of the key')
assert.deepEqual(effectiveVoice({ voice_id: 'a', speed: 1 }, { speed: 1.2, style: undefined }), { voice_id: 'a', speed: 1.2 })
assert.deepEqual(effectiveVoice({ voice_id: 'a' }), { voice_id: 'a' })
console.log('narration: ok')
