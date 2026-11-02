import { describe, expect, it } from 'vitest'
import { CallerTracker, claimedCallerOf, OWNER, ovUserOf, peerOf } from '../src/identity.ts'
import { feishu, ownerSource, session, testConfig } from './helpers.ts'

describe('claimedCallerOf', () => {
  it('names the principal a prompt records', () => {
    expect(claimedCallerOf(feishu('ou_1'), 'skip')).toEqual({ kind: 'set', principal: { kind: 'feishu-user', userId: 'ou_1' } })
  })

  it('treats a browser prompt without a principal as the owner', () => {
    expect(claimedCallerOf(ownerSource, 'skip')).toEqual({ kind: 'set', principal: OWNER })
  })

  it('applies the unattributed policy to a prompt with neither', () => {
    expect(claimedCallerOf({ kind: 'user' }, 'skip')).toEqual({ kind: 'set', principal: undefined })
    expect(claimedCallerOf({ kind: 'user' }, 'owner')).toEqual({ kind: 'set', principal: OWNER })
  })

  it('gives a malformed principal no identity', () => {
    expect(claimedCallerOf({ kind: 'user', rpcId: 'r', principal: 'ou_1' }, 'owner')).toEqual({ kind: 'set', principal: undefined })
    expect(claimedCallerOf({ kind: 'user', principal: { userId: 'ou_1' } }, 'owner')).toEqual({ kind: 'set', principal: undefined })
  })

  it('keeps the caller for messages that are not prompts', () => {
    expect(claimedCallerOf({ kind: 'subagent' }, 'owner')).toEqual({ kind: 'keep' })
  })
})

describe('ovUserOf', () => {
  const config = testConfig()

  it('fills the template from principal fields', () => {
    expect(ovUserOf({ kind: 'feishu-user', userId: 'ou_abc' }, config)).toBe('feishu-ou_abc')
    expect(ovUserOf(OWNER, config)).toBe('owner')
  })

  it('fails closed for unknown kinds, missing fields, and unsafe values', () => {
    expect(ovUserOf({ kind: 'cas-user', account: 'x' }, config)).toBeUndefined()
    expect(ovUserOf({ kind: 'feishu-user' }, config)).toBeUndefined()
    expect(ovUserOf({ kind: 'feishu-user', userId: '../owner' }, config)).toBeUndefined()
    expect(ovUserOf({ kind: 'toString' }, config)).toBeUndefined()
  })
})

describe('peerOf', () => {
  const peer = { cwdPattern: '/chats/(?<peer>[^/]+)$', prefix: 'chat-' }

  it('maps the creation directory to a peer', () => {
    expect(peerOf('/data/chats/oc_1', peer)).toBe('chat-oc_1')
  })

  it('gives no peer when unconfigured, unmatched, or unsafe', () => {
    expect(peerOf('/data/chats/oc_1', undefined)).toBeUndefined()
    expect(peerOf('/data/other', peer)).toBeUndefined()
    expect(peerOf('/data/chats/a b', peer)).toBeUndefined()
  })
})

describe('CallerTracker', () => {
  it('follows the caller of each claimed prompt', () => {
    const tracker = new CallerTracker(() => testConfig())
    const root = session('s1')
    expect(tracker.identityOf(root)).toBeUndefined()
    tracker.onClaimed(root, feishu('ou_1'))
    expect(tracker.identityOf(root)).toEqual({ kind: 'feishu-user', user: 'feishu-ou_1', sharedReader: false })
    tracker.onClaimed(root, { kind: 'job' })
    expect(tracker.identityOf(root)?.user).toBe('feishu-ou_1')
    tracker.onClaimed(root, ownerSource)
    expect(tracker.identityOf(root)).toEqual({ kind: 'owner', user: 'owner', sharedReader: true })
    tracker.onClaimed(root, { kind: 'user' })
    expect(tracker.identityOf(root)).toBeUndefined()
  })

  it('gives a subagent its root caller and the root peer', () => {
    const tracker = new CallerTracker(() => testConfig({ peer: { cwdPattern: '/chats/(?<peer>[^/]+)$' } }))
    const root = session('root', { cwd: '/chats/oc_9' })
    const child = session('child', { parentSession: 'root', cwd: '/elsewhere' })
    const grandchild = session('grandchild', { parentSession: 'child' })
    tracker.onClaimed(root, feishu('ou_2'))
    tracker.onClaimed(child, { kind: 'subagent' })
    expect(tracker.identityOf(grandchild)).toEqual({ kind: 'feishu-user', user: 'feishu-ou_2', peer: 'oc_9', sharedReader: false })
    expect(tracker.rootOf('grandchild')).toBe('root')
  })

  it('forgets Sessions', () => {
    const tracker = new CallerTracker(() => testConfig())
    const root = session('s1')
    tracker.onClaimed(root, ownerSource)
    tracker.forget('s1')
    expect(tracker.rootOf('s1')).toBe('s1')
    tracker.onClaimed(root, ownerSource)
    tracker.clear()
    expect(tracker.identityOf(session('s2'))).toBeUndefined()
  })
})
