/**
 * Host bundle smoke test: import the built `lib/index.js` as an installed DSH
 * profile would (plain Node ESM, no TypeScript transform) and check the Cordis
 * plugin surface.
 *
 * Run after `pnpm build`: node scripts/verify-host-loader.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const plugin = await import('../lib/index.js')

// DSH HMR re-imports an upgraded package from evicted caches, and Node gives a
// re-imported CommonJS re-export chain empty exports, so the bundle must load
// no CommonJS module.
const commonJs = Object.keys(createRequire(import.meta.url).cache)
assert.deepEqual(commonJs, [], `host bundle must load no CommonJS module, loaded:\n${commonJs.join('\n')}`)

assert.equal(plugin.name, 'dsh-openviking', 'host bundle must export the Cordis plugin name')
assert.equal(typeof plugin.apply, 'function', 'host bundle must export apply()')
assert.deepEqual([...plugin.inject], ['tools', 'credentials'], 'unexpected inject list')
assert.ok(plugin.Config !== undefined, 'host bundle must export the Config schema')

// The Loader validates a composition entry through Config's Standard Schema.
const minimal = await plugin.Config['~standard'].validate({ endpoint: 'http://openviking:1933/' })
assert.equal(minimal.issues, undefined, 'an endpoint alone should validate')
assert.equal(minimal.value.endpoint, 'http://openviking:1933', 'the endpoint trailing slash is trimmed')
const missing = await plugin.Config['~standard'].validate(undefined)
assert.ok(missing.issues !== undefined, 'the endpoint is required')
const keyValue = await plugin.Config['~standard'].validate({ endpoint: 'http://openviking:1933', apiKeyRef: 'sk-abc-123' })
assert.ok(keyValue.issues !== undefined, 'a key value in place of a credential reference must be rejected')
const badTemplate = await plugin.Config['~standard'].validate({ endpoint: 'http://openviking:1933', identities: { 'feishu-user': 'feishu/{userId}' } })
assert.ok(badTemplate.issues !== undefined, 'an identity template with unsafe characters must be rejected')

console.log('OK: lib/index.js imports as plain ESM and exposes the Cordis plugin surface')
