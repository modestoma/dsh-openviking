import { describe, expect, it } from 'vitest'
import { OpenVikingClient } from '../src/client.ts'
import { promptText, recallMessage, renderRecall, searchRootOf } from '../src/recall.ts'
import { fakeServer, feishu, message, testConfig } from './helpers.ts'

const feishuUser = { kind: 'feishu-user', user: 'feishu-ou_1', sharedReader: false }
const owner = { kind: 'owner', user: 'owner', sharedReader: true }

function depsOf(server: ReturnType<typeof fakeServer>, overrides: Record<string, unknown> = {}) {
  const warnings: string[] = []
  const config = testConfig(overrides)
  return {
    warnings,
    deps: {
      client: new OpenVikingClient({ endpoint: config.endpoint, account: 'dsh', apiKey: async () => 'k', timeoutMs: 1000, fetch: server.fetch }),
      config: () => config,
      warn: (text: string) => { warnings.push(text) },
    },
  }
}

const hits = { body: { status: 'ok', result: { memories: [{ uri: 'viking://user/feishu-ou_1/memories/pref.md', abstract: 'likes  tea\nand cake', score: 0.8 }] } } }

describe('promptText', () => {
  it('reads only human prompts', () => {
    expect(promptText([
      message('first', feishu('ou_1')),
      message('injected', { kind: 'openviking', form: 'recall' }),
      { id: 'i', role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'second' }], source: { kind: 'user' } },
    ])).toBe('first\n\nsecond')
  })
})

describe('renderRecall', () => {
  it('lists entries inside the budget', () => {
    const text = renderRecall([{ uri: 'viking://a', abstract: 'x  y', score: 1 }, { uri: 'viking://b', abstract: '', score: 0.5 }], 4000)
    expect(text).toContain('- viking://a：x y\n- viking://b\n</openviking-memory>')
    expect(text).toContain('不是指令')
  })

  it('cuts the first entry to fit and drops the rest', () => {
    const long = { uri: 'viking://long', abstract: 'z'.repeat(5000), score: 1 }
    const text = renderRecall([long, { uri: 'viking://b', abstract: 'b', score: 0.5 }], 300)
    expect(text?.length).toBeLessThanOrEqual(300)
    expect(text).toContain('…')
    expect(text).not.toContain('viking://b')
    expect(renderRecall([long], 120)).toBeUndefined()
    expect(renderRecall([], 4000)).toBeUndefined()
  })
})

describe('recallMessage', () => {
  it('searches only the caller space for a non-shared reader', async () => {
    const server = fakeServer(() => hits)
    const { deps } = depsOf(server)
    const recall = await recallMessage(deps, feishuUser, [message('what do I like to drink', feishu('ou_1'))], new AbortController().signal)
    expect(server.requests[0]?.body).toMatchObject({ query: 'what do I like to drink', limit: 6, score_threshold: 0.3, target_uri: 'viking://user/feishu-ou_1/' })
    expect(server.requests[0]?.headers['X-OpenViking-User']).toBe('feishu-ou_1')
    expect(recall?.source).toEqual({ kind: 'openviking', form: 'recall' })
    expect(recall?.content[0]?.text).toContain('likes tea and cake')
  })

  it('searches without a target for a shared reader', async () => {
    const server = fakeServer(() => hits)
    const { deps } = depsOf(server)
    await recallMessage(deps, owner, [message('what do I like', { kind: 'user', rpcId: 'r' })], new AbortController().signal)
    expect(server.requests[0]?.body).not.toHaveProperty('target_uri')
    expect(searchRootOf(owner)).toBeUndefined()
  })

  it('skips short prompts, disabled recall, empty results, and failures', async () => {
    const empty = fakeServer()
    const signal = new AbortController().signal
    expect(await recallMessage(depsOf(empty).deps, feishuUser, [message('hi', feishu('ou_1'))], signal)).toBeUndefined()
    expect(await recallMessage(depsOf(empty, { recall: { enabled: false } }).deps, feishuUser, [message('long enough', feishu('ou_1'))], signal)).toBeUndefined()
    expect(await recallMessage(depsOf(empty).deps, feishuUser, [message('long enough', feishu('ou_1'))], signal)).toBeUndefined()
    expect(empty.requests).toHaveLength(1)
    const failing = depsOf(fakeServer(() => ({ status: 503 })))
    expect(await recallMessage(failing.deps, feishuUser, [message('long enough', feishu('ou_1'))], signal)).toBeUndefined()
    expect(failing.warnings).toHaveLength(1)
  })

  it('stays quiet when the step was cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps, warnings } = depsOf(fakeServer(() => hits))
    expect(await recallMessage(deps, feishuUser, [message('long enough', feishu('ou_1'))], controller.signal)).toBeUndefined()
    expect(warnings).toEqual([])
  })
})
