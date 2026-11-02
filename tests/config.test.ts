import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('configuration', () => {
  it('fills defaults around the endpoint', () => {
    const config = resolveConfig({ endpoint: 'http://ov:1933//' })
    expect(config.endpoint).toBe('http://ov:1933')
    expect(config.account).toBe('dsh')
    expect(config.apiKeyRef).toBe('OPENVIKING_API_KEY')
    expect(config.identities).toEqual({ owner: 'owner', 'feishu-user': 'feishu-{userId}' })
    expect(config.sharedReaders).toEqual(['owner'])
    expect(config.unattributedPrompts).toBe('skip')
    expect(config.recall.limit).toBe(6)
    expect(config.capture.toolDeny).toEqual([])
    expect(config.tools.enabled).toBe(true)
  })

  it.each([
    ['a missing endpoint', {}],
    ['a non-http endpoint', { endpoint: 'ftp://ov' }],
    ['a key value as the credential reference', { endpoint: 'http://ov', apiKeyRef: 'sk-1-2' }],
    ['an unsafe identity template', { endpoint: 'http://ov', identities: { owner: 'a b' } }],
    ['a peer pattern without the peer group', { endpoint: 'http://ov', peer: { cwdPattern: '/chats/(.+)' } }],
    ['an invalid peer pattern', { endpoint: 'http://ov', peer: { cwdPattern: '(?<peer>' } }],
    ['a tool pattern with spaces', { endpoint: 'http://ov', capture: { toolDeny: ['a b'] } }],
  ])('rejects %s', (_label, input) => {
    expect(() => resolveConfig(input)).toThrow()
  })

  it('accepts a peer pattern with a named group', () => {
    const config = resolveConfig({ endpoint: 'http://ov', peer: { cwdPattern: '/chats/(?<peer>[^/]+)$', prefix: 'chat-' } })
    expect(config.peer).toEqual({ cwdPattern: '/chats/(?<peer>[^/]+)$', prefix: 'chat-' })
  })
})
