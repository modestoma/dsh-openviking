import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { HostContext, PreStepDecision, PreStepPayload, Session, SessionEvent, ToolActivationContext, ToolDefinition, UserMessage } from '../src/host.ts'
import { fakeServer, feishu, message, ownerSource, session } from './helpers.ts'
import type { Recorded, Reply } from './helpers.ts'

type Listener = (...args: never[]) => unknown

function fakeContext(credential: string | null = 'root-key') {
  const listeners = new Map<string, { listener: Listener; options?: unknown }>()
  const tools: { definition: ToolDefinition; when?: (context: ToolActivationContext) => boolean | Promise<boolean> }[] = []
  const disposers: (() => void)[] = []
  const warnings: string[] = []
  const ctx: HostContext = {
    tools: {
      register: (definition, options) => {
        tools.push({ definition: definition as ToolDefinition, ...options?.when === undefined ? {} : { when: options.when } })
        return () => {}
      },
    },
    credentials: { resolve: async () => credential === null ? undefined : { value: credential, source: 'env' } },
    logger: { warn: (text: string) => { warnings.push(text) } },
    effect: callback => {
      const disposer = callback()
      if (disposer !== undefined) disposers.push(disposer)
      return () => {}
    },
    on: ((event: string, listener: Listener, options?: unknown) => {
      listeners.set(event, { listener, options })
      return () => {}
    }) as HostContext['on'],
  }
  return {
    ctx,
    tools,
    warnings,
    dispose: () => { for (const disposer of disposers) disposer() },
    options: (event: string) => listeners.get(event)?.options,
    claimed: (target: Session, claimedMessage: UserMessage) => (listeners.get('agent/inbox/claimed')?.listener as (payload: unknown) => void)({ agent: { session: target }, message: claimedMessage }),
    preStep: (target: Session, decision: PreStepDecision) => (listeners.get('agent/pre-step')?.listener as (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)(
      { agent: { session: target }, messages: [], signal: new AbortController().signal },
      async () => decision,
    ),
    event: (target: Session, sessionEvent: SessionEvent) => (listeners.get('session/event')?.listener as (s: Session, e: SessionEvent) => void)(target, sessionEvent),
  }
}

const recallHit = (request: Recorded): Reply => request.path === '/api/v1/search/find'
  ? { body: { status: 'ok', result: { memories: [{ uri: `viking://user/${request.headers['X-OpenViking-User']}/memories/a.md`, abstract: 'a fact', score: 0.9 }] } } }
  : {}

describe('plugin', () => {
  it('exports the Cordis plugin surface', () => {
    expect(name).toBe('dsh-openviking')
    expect(inject).toEqual(['tools', 'credentials'])
    expect(Config.safeParse({ endpoint: 'http://ov' }).success).toBe(true)
  })

  it('appends recall for the caller of the admitted prompt as the outermost listener', async () => {
    const server = fakeServer(recallHit)
    const host = fakeContext()
    apply(host.ctx, { endpoint: 'http://ov.test' }, { fetch: server.fetch })
    expect(host.options('agent/pre-step')).toEqual({ prepend: true })
    const root = session('s1')
    const prompt = message('what did I say about tea', feishu('ou_1'))
    const decision = await host.preStep(root, { kind: 'enter', messages: [prompt], startsRequestSeries: true })
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.startsRequestSeries).toBe(true)
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[1]?.source).toEqual({ kind: 'openviking', form: 'recall' })
    expect(decision.messages[1]?.content[0]?.text).toContain('viking://user/feishu-ou_1/memories/a.md')
    expect(server.requests[0]?.headers).toMatchObject({ 'X-API-Key': 'root-key', 'X-OpenViking-Account': 'dsh', 'X-OpenViking-User': 'feishu-ou_1' })
  })

  it('passes rejected steps, unknown callers, and subagents through untouched', async () => {
    const server = fakeServer(recallHit)
    const host = fakeContext()
    apply(host.ctx, { endpoint: 'http://ov.test' }, { fetch: server.fetch })
    const root = session('s1')
    expect(await host.preStep(root, { kind: 'reject' })).toEqual({ kind: 'reject' })
    const anonymous = { kind: 'enter' as const, messages: [message('a prompt nobody owns', { kind: 'user' })] }
    expect(await host.preStep(root, anonymous)).toBe(anonymous)
    host.claimed(root, message('hello there', ownerSource))
    const child = session('c1', { parentSession: 's1' })
    const childStep = { kind: 'enter' as const, messages: [message('subagent task text', { kind: 'user', rpcId: 'x' })] }
    expect(await host.preStep(child, childStep)).toBe(childStep)
    expect(server.requests).toEqual([])
  })

  it('captures Session events and commits on dispose', async () => {
    const server = fakeServer()
    const host = fakeContext()
    apply(host.ctx, { endpoint: 'http://ov.test' }, { fetch: server.fetch })
    const root = session('s1')
    host.claimed(root, message('remember tea', ownerSource))
    host.event(root, { type: 'user/message', data: message('remember tea', ownerSource) })
    host.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.requests.map(request => request.path)).toEqual(['/api/v1/sessions', '/api/v1/sessions/dsh-s1-owner/messages', '/api/v1/sessions/dsh-s1-owner/commit'])
  })

  it('offers the memory tools only to turns with an identity', async () => {
    const host = fakeContext()
    apply(host.ctx, { endpoint: 'http://ov.test' }, { fetch: fakeServer().fetch })
    expect(host.tools.map(tool => tool.definition.name)).toEqual(['memory_search', 'memory_read', 'memory_list', 'memory_remember', 'memory_forget'])
    const root = session('s1')
    const when = host.tools[0]?.when
    expect(await when?.({ agent: { session: root } })).toBe(false)
    host.claimed(root, message('hi', feishu('ou_1')))
    expect(await when?.({ agent: { session: root } })).toBe(true)
    host.claimed(root, message('hi', { kind: 'user', principal: { kind: 'cas-user', account: 'x' } }))
    expect(await when?.({ agent: { session: root } })).toBe(false)
  })

  it('registers no tools when disabled and warns about a missing key', async () => {
    const host = fakeContext(null)
    const server = fakeServer()
    apply(host.ctx, { endpoint: 'http://ov.test', tools: { enabled: false } }, { fetch: server.fetch })
    expect(host.tools).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(host.warnings.some(text => text.includes('is not set'))).toBe(true)
    const root = session('s1')
    const decision = await host.preStep(root, { kind: 'enter', messages: [message('long enough prompt', ownerSource)] })
    expect(decision.kind === 'enter' && decision.messages).toHaveLength(1)
    expect(server.requests).toEqual([])
    expect(host.warnings.some(text => text.includes('recall for'))).toBe(true)
  })
})
