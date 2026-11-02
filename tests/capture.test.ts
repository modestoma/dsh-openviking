import { describe, expect, it } from 'vitest'
import { CaptureQueue, matchesToolPattern, ovSessionIdOf } from '../src/capture.ts'
import { OpenVikingClient } from '../src/client.ts'
import type { SessionEvent } from '../src/host.ts'
import { CallerTracker } from '../src/identity.ts'
import { fakeServer, feishu, message, ownerSource, session, testConfig } from './helpers.ts'
import type { Recorded, Reply } from './helpers.ts'

function setup(overrides: Record<string, unknown> = {}, handler?: (request: Recorded) => Reply) {
  const server = fakeServer(handler)
  const config = testConfig(overrides)
  const warnings: string[] = []
  const callers = new CallerTracker(() => config)
  const client = new OpenVikingClient({ endpoint: config.endpoint, account: 'dsh', apiKey: async () => 'k', timeoutMs: 1000, fetch: server.fetch })
  const queue = new CaptureQueue({ client, callers, config: () => config, warn: (text: string) => { warnings.push(text) } })
  return { server, callers, queue, warnings }
}

const userEvent = (text: string, source = ownerSource): SessionEvent => ({ type: 'user/message', data: message(text, source) })
const assistantEvent = (text: string, interrupted?: true): SessionEvent => ({
  type: 'assistant/message',
  data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...interrupted === undefined ? {} : { interrupted } },
})
const messagesOf = (requests: readonly Recorded[]) => requests
  .filter(request => request.path.endsWith('/messages'))
  .map(request => ({ session: decodeURIComponent(request.path.split('/')[4] ?? ''), user: request.headers['X-OpenViking-User'], role: request.body?.role, content: request.body?.content }))

describe('ovSessionIdOf', () => {
  it('keeps readable ids and hashes unsafe ones', () => {
    expect(ovSessionIdOf('s1', { user: 'feishu-ou_1', peer: 'chat-1' })).toBe('dsh-s1-feishu-ou_1-chat-1')
    expect(ovSessionIdOf('s 1', { user: 'u' })).toMatch(/^dsh-[0-9a-f]{40}$/u)
  })
})

describe('matchesToolPattern', () => {
  it('matches whole names with * wildcards', () => {
    expect(matchesToolPattern('kb_wiki_read', 'kb_wiki_*')).toBe(true)
    expect(matchesToolPattern('my_kb_wiki_read', 'kb_wiki_*')).toBe(false)
    expect(matchesToolPattern('a.b', 'a.b')).toBe(true)
    expect(matchesToolPattern('axb', 'a.b')).toBe(false)
  })
})

describe('CaptureQueue', () => {
  it('writes each user turn of a shared Session into that user own session', async () => {
    const { server, callers, queue } = setup()
    const root = session('s1')
    callers.onClaimed(root, feishu('ou_a'))
    queue.onEvent(root, userEvent('alpha asks', feishu('ou_a')))
    queue.onEvent(root, assistantEvent('reply to alpha'))
    callers.onClaimed(root, feishu('ou_b'))
    queue.onEvent(root, userEvent('beta asks', feishu('ou_b')))
    queue.onEvent(root, assistantEvent('reply to beta'))
    await queue.idle()
    expect(messagesOf(server.requests)).toEqual([
      { session: 'dsh-s1-feishu-ou_a', user: 'feishu-ou_a', role: 'user', content: 'alpha asks' },
      { session: 'dsh-s1-feishu-ou_a', user: 'feishu-ou_a', role: 'assistant', content: 'reply to alpha' },
      { session: 'dsh-s1-feishu-ou_b', user: 'feishu-ou_b', role: 'user', content: 'beta asks' },
      { session: 'dsh-s1-feishu-ou_b', user: 'feishu-ou_b', role: 'assistant', content: 'reply to beta' },
    ])
    const created = server.requests.filter(request => request.path === '/api/v1/sessions').map(request => request.body?.session_id)
    expect(created).toEqual(['dsh-s1-feishu-ou_a', 'dsh-s1-feishu-ou_b'])
  })

  it('captures nothing without an identity and skips injected context and interrupted replies', async () => {
    const { server, callers, queue } = setup()
    const root = session('s1')
    queue.onEvent(root, userEvent('nobody', { kind: 'user' }))
    callers.onClaimed(root, ownerSource)
    queue.onEvent(root, { type: 'user/message', data: message('recalled', { kind: 'openviking', form: 'recall' }) })
    queue.onEvent(root, assistantEvent('half', true))
    queue.onEvent(root, assistantEvent('   '))
    queue.onEvent(root, { type: 'tool/result', data: { output: 'secret' } })
    await queue.idle()
    expect(server.requests).toEqual([])
  })

  it('stops capturing replies after a denied tool until the turn ends', async () => {
    const { server, callers, queue } = setup({ capture: { toolDeny: ['kb_*'] } })
    const root = session('s1')
    const child = session('c1', { parentSession: 's1' })
    callers.onClaimed(root, ownerSource)
    callers.onClaimed(child, { kind: 'subagent' })
    queue.onEvent(root, userEvent('read the wiki'))
    queue.onEvent(root, { type: 'tool/call', data: { turn: 1, callId: 'c', name: 'shell' } })
    queue.onEvent(root, assistantEvent('allowed tool reply'))
    queue.onEvent(root, { type: 'tool/call', data: { turn: 1, callId: 'd', name: 'kb_read' } })
    queue.onEvent(root, assistantEvent('quotes the wiki'))
    queue.onEvent(root, { type: 'turn/end', data: { turn: 1 } })
    queue.onEvent(root, userEvent('next question'))
    queue.onEvent(root, assistantEvent('fresh reply'))
    await queue.idle()
    expect(messagesOf(server.requests).map(entry => entry.content)).toEqual(['read the wiki', 'allowed tool reply', 'next question', 'fresh reply'])
  })

  it('keeps the root taint until the root turn ends, whatever its subagents do', async () => {
    for (const subagents of [false, true]) {
      const { server, callers, queue } = setup({ subagents, capture: { toolDeny: ['kb_*'] } })
      const root = session('s1')
      const child = session('c1', { parentSession: 's1' })
      callers.onClaimed(root, ownerSource)
      queue.onEvent(root, userEvent('ask'))
      queue.onEvent(child, { type: 'tool/call', data: { turn: 1, callId: 'k', name: 'kb_read' } })
      queue.onEvent(child, { type: 'turn/end', data: { turn: 1 } })
      queue.onEvent(root, assistantEvent('quotes the subagent report'))
      queue.onEvent(root, { type: 'turn/end', data: { turn: 1 } })
      queue.onEvent(root, assistantEvent('later reply'))
      await queue.idle()
      expect(messagesOf(server.requests).map(entry => entry.content)).toEqual(['ask', 'later reply'])
    }
  })

  it('retries a failed commit without appending the message again', async () => {
    let commitDown = true
    const { server, callers, queue } = setup({ capture: { commitAfterChars: 1000 } }, request => commitDown && request.path.endsWith('/commit') ? { status: 503 } : {})
    const root = session('s1')
    callers.onClaimed(root, ownerSource)
    queue.onEvent(root, userEvent('z'.repeat(1000)))
    await queue.idle()
    expect(queue.pendingCount()).toBe(1)
    commitDown = false
    queue.onEvent(root, userEvent('next'))
    await queue.idle()
    expect(queue.pendingCount()).toBe(0)
    expect(messagesOf(server.requests).map(entry => entry.content?.toString().slice(0, 4))).toEqual(['zzzz', 'next'])
    expect(server.requests.filter(request => request.path.endsWith('/commit'))).toHaveLength(2)
  })

  it('skips subagent Sessions unless configured', async () => {
    const off = setup()
    const root = session('s1')
    const child = session('c1', { parentSession: 's1' })
    off.callers.onClaimed(root, ownerSource)
    off.queue.onEvent(child, assistantEvent('child reply'))
    await off.queue.idle()
    expect(off.server.requests).toEqual([])
    const on = setup({ subagents: true })
    on.callers.onClaimed(root, ownerSource)
    on.callers.onClaimed(child, { kind: 'subagent' })
    on.queue.onEvent(child, assistantEvent('child reply'))
    await on.queue.idle()
    expect(messagesOf(on.server.requests)).toEqual([{ session: 'dsh-s1-owner', user: 'owner', role: 'assistant', content: 'child reply' }])
  })

  it('does nothing while capture is disabled', async () => {
    const { server, callers, queue } = setup({ capture: { enabled: false } })
    const root = session('s1')
    callers.onClaimed(root, ownerSource)
    queue.onEvent(root, userEvent('hello'))
    await queue.idle()
    expect(server.requests).toEqual([])
  })

  it('commits after enough text, on compaction, and on stop', async () => {
    const { server, callers, queue } = setup({ capture: { commitAfterChars: 1000, maxMessageChars: 600 } })
    const root = session('s1')
    callers.onClaimed(root, ownerSource)
    queue.onEvent(root, userEvent('x'.repeat(700)))
    queue.onEvent(root, assistantEvent('y'.repeat(500)))
    await queue.idle()
    const commits = () => server.requests.filter(request => request.path.endsWith('/commit')).length
    expect(commits()).toBe(1)
    expect(messagesOf(server.requests)[0]?.content).toHaveLength(601)
    queue.onEvent(root, { type: 'compaction/start' })
    await queue.idle()
    expect(commits()).toBe(1)
    queue.onEvent(root, userEvent('short'))
    queue.onEvent(root, { type: 'compaction/start' })
    await queue.idle()
    expect(commits()).toBe(2)
    queue.onEvent(root, userEvent('after compaction'))
    queue.start()
    await queue.stop()
    expect(commits()).toBe(3)
  })

  it('keeps retryable failures in order and retries them before later writes', async () => {
    let down = true
    const { server, callers, queue, warnings } = setup({}, request => down && request.path.endsWith('/messages') ? { status: 503 } : {})
    const root = session('s1')
    callers.onClaimed(root, ownerSource)
    queue.onEvent(root, userEvent('one'))
    queue.onEvent(root, userEvent('two'))
    await queue.idle()
    expect(queue.pendingCount()).toBe(2)
    down = false
    queue.onEvent(root, userEvent('three'))
    await queue.idle()
    expect(queue.pendingCount()).toBe(0)
    const delivered = server.requests.filter(request => request.path.endsWith('/messages') && request.body?.content !== undefined)
    expect(delivered.slice(-3).map(request => request.body?.content)).toEqual(['one', 'two', 'three'])
    expect(warnings).toEqual([])
  })

  it('drops non-retryable failures and the oldest writes beyond the limit', async () => {
    const rejected = setup({}, request => request.path.endsWith('/messages') ? { status: 400 } : {})
    const root = session('s1')
    rejected.callers.onClaimed(root, ownerSource)
    rejected.queue.onEvent(root, userEvent('bad'))
    await rejected.queue.idle()
    expect(rejected.queue.pendingCount()).toBe(0)
    expect(rejected.warnings[0]).toContain('dropped')
    const full = setup({ capture: { pendingMax: 1 } }, request => request.path.endsWith('/messages') ? { status: 500 } : {})
    full.callers.onClaimed(root, ownerSource)
    full.queue.onEvent(root, userEvent('first'))
    full.queue.onEvent(root, userEvent('second'))
    await full.queue.idle()
    expect(full.queue.pendingCount()).toBe(1)
    expect(full.warnings.some(text => text.includes('retry queue full'))).toBe(true)
  })
})
