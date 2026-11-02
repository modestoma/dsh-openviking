import { describe, expect, it } from 'vitest'
import { OpenVikingClient } from '../src/client.ts'
import { CallerTracker } from '../src/identity.ts'
import type { ToolDefinition } from '../src/host.ts'
import { createTools, deletableUri, noteFileName, normalizeUri, readableUri } from '../src/tools.ts'
import { fakeServer, feishu, ownerSource, session, testConfig } from './helpers.ts'
import type { Recorded, Reply } from './helpers.ts'

const feishuUser = { kind: 'feishu-user', user: 'feishu-ou_1', sharedReader: false }
const owner = { kind: 'owner', user: 'owner', sharedReader: true }

function setup(handler?: (request: Recorded) => Reply) {
  const server = fakeServer(handler)
  const config = testConfig()
  const callers = new CallerTracker(() => config)
  const client = new OpenVikingClient({ endpoint: config.endpoint, account: 'dsh', apiKey: async () => 'k', timeoutMs: 1000, fetch: server.fetch })
  const tools = new Map(createTools({ client, callers, config: () => config, now: () => new Date('2026-11-02T08:09:10.123Z') }).map(tool => [tool.name, tool]))
  const root = session('s1')
  const run = (name: string, args: unknown, target = root) => (tools.get(name) as ToolDefinition).execute(args, { signal: new AbortController().signal, agent: { session: target } })
  return { server, callers, tools, root, run }
}

describe('URI checks', () => {
  it('normalizes slashes and rejects escapes', () => {
    expect(normalizeUri(' viking://user//u/memories/ ')).toBe('viking://user/u/memories')
    for (const bad of ['file:///etc/passwd', 'viking://user/u/../owner', 'viking://user/u/./x', 'viking://user/u/%2e%2e/owner', 'viking://user/u\\..\\owner']) {
      expect(() => normalizeUri(bad)).toThrow('[invalid]')
    }
  })

  it('limits a non-shared reader to its own space', () => {
    expect(readableUri(feishuUser, 'viking://user/feishu-ou_1')).toBe('viking://user/feishu-ou_1')
    expect(readableUri(feishuUser, 'viking://user/feishu-ou_1/memories/a.md')).toBe('viking://user/feishu-ou_1/memories/a.md')
    expect(() => readableUri(feishuUser, 'viking://user/feishu-ou_10/memories/a.md')).toThrow('[forbidden]')
    expect(() => readableUri(feishuUser, 'viking://resources/kb/page.md')).toThrow('[forbidden]')
    expect(readableUri(owner, 'viking://resources/kb/page.md')).toBe('viking://resources/kb/page.md')
  })

  it('allows deleting only files under the caller own memories', () => {
    expect(deletableUri(owner, 'viking://user/owner/memories/notes/a.md')).toBe('viking://user/owner/memories/notes/a.md')
    expect(() => deletableUri(owner, 'viking://user/owner/memories/')).toThrow('[forbidden]')
    expect(() => deletableUri(owner, 'viking://resources/kb/page.md')).toThrow('[forbidden]')
    expect(() => deletableUri(feishuUser, 'viking://user/owner/memories/a.md')).toThrow('[forbidden]')
  })

  it('builds safe note file names', () => {
    const now = new Date('2026-11-02T08:09:10.123Z')
    expect(noteFileName('Tea  Preference!', now)).toMatch(/^20261102T080910Z-tea-preference-[0-9a-f]{8}\.md$/u)
    expect(noteFileName('Tea', now)).not.toBe(noteFileName('Tea', now))
    expect(noteFileName('喝茶偏好', now)).toMatch(/^20261102T080910Z-[0-9a-f]{8}\.md$/u)
    expect(noteFileName(undefined, now)).toMatch(/^20261102T080910Z-[0-9a-f]{8}\.md$/u)
  })
})

describe('memory tools', () => {
  it('refuse a turn without an identity', async () => {
    const { run, server } = setup()
    await expect(run('memory_search', { query: 'x' })).rejects.toThrow('[no-identity]')
    await expect((setup().tools.get('memory_read') as ToolDefinition).execute({ uri: 'viking://user/owner/a' }, { signal: new AbortController().signal })).rejects.toThrow('[no-identity]')
    expect(server.requests).toEqual([])
  })

  it('reject invalid arguments', async () => {
    const { run, callers, root } = setup()
    callers.onClaimed(root, ownerSource)
    await expect(run('memory_search', { query: '', extra: 1 })).rejects.toThrow('[invalid]')
  })

  it('search the caller space and drop hits outside it', async () => {
    const { run, callers, root, server } = setup(() => ({
      body: { status: 'ok', result: { memories: [{ uri: 'viking://user/feishu-ou_1/memories/a.md', score: 0.4 }], resources: [{ uri: 'viking://resources/kb.md', score: 0.9 }, { uri: 'bad uri', score: 0.1 }] } },
    }))
    callers.onClaimed(root, feishu('ou_1'))
    const result = await run('memory_search', { query: 'tea', limit: 3 })
    expect(result).toEqual({ results: [{ uri: 'viking://user/feishu-ou_1/memories/a.md', abstract: '', score: 0.4 }] })
    expect(server.requests[0]?.body).toEqual({ query: 'tea', limit: 3, score_threshold: 0, target_uri: 'viking://user/feishu-ou_1/' })
  })

  it('give a shared reader every hit', async () => {
    const { run, callers, root } = setup(() => ({ body: { status: 'ok', result: { resources: [{ uri: 'viking://resources/kb.md', score: 0.9 }] } } }))
    callers.onClaimed(root, ownerSource)
    expect(await run('memory_search', { query: 'kb' })).toEqual({ results: [{ uri: 'viking://resources/kb.md', abstract: '', score: 0.9 }] })
  })

  it('read and list inside the caller space', async () => {
    const { run, callers, root, server } = setup(request => request.path === '/api/v1/content/read'
      ? { body: { status: 'ok', result: 'remembered text' } }
      : { body: { status: 'ok', result: [{ uri: 'viking://user/feishu-ou_1/memories/a.md', name: 'a.md', is_dir: false, abstract: 'A' }, 'viking://user/feishu-ou_1/memories/b', 7] } })
    callers.onClaimed(root, feishu('ou_1'))
    expect(await run('memory_read', { uri: 'viking://user/feishu-ou_1/memories/a.md' })).toEqual({ uri: 'viking://user/feishu-ou_1/memories/a.md', content: 'remembered text' })
    expect(await run('memory_list', {})).toEqual({
      uri: 'viking://user/feishu-ou_1/memories',
      entries: [{ uri: 'viking://user/feishu-ou_1/memories/a.md', name: 'a.md', isDir: false, abstract: 'A' }, { uri: 'viking://user/feishu-ou_1/memories/b' }, {}],
    })
    await expect(run('memory_read', { uri: 'viking://resources/kb.md' })).rejects.toThrow('[forbidden]')
    await expect(run('memory_list', { uri: 'viking://user/owner/' })).rejects.toThrow('[forbidden]')
    expect(server.requests).toHaveLength(2)
  })

  it('reject a non-text read result', async () => {
    const { run, callers, root } = setup(() => ({ body: { status: 'ok', result: { binary: true } } }))
    callers.onClaimed(root, ownerSource)
    await expect(run('memory_read', { uri: 'viking://user/owner/memories/img' })).rejects.toThrow('[invalid]')
  })

  it('remember into the caller own notes and forget only own memories', async () => {
    const { run, callers, root, server } = setup()
    callers.onClaimed(root, ownerSource)
    const { uri } = await run('memory_remember', { content: 'prefers green tea', title: 'Tea' }) as { uri: string }
    expect(uri).toMatch(/^viking:\/\/user\/owner\/memories\/notes\/20261102T080910Z-tea-[0-9a-f]{8}\.md$/u)
    expect(server.requests[0]).toMatchObject({ path: '/api/v1/content/write', body: { uri, content: '# Tea\n\nprefers green tea\n' } })
    expect(await run('memory_forget', { uri })).toEqual({ uri, deleted: true })
    expect(server.requests[1]).toMatchObject({ method: 'DELETE', path: '/api/v1/fs', query: { uri, recursive: 'false' } })
    await expect(run('memory_forget', { uri: 'viking://resources/kb.md' })).rejects.toThrow('[forbidden]')
  })

  it('act as the root caller inside a subagent', async () => {
    const { run, callers, root, server } = setup()
    const child = session('c1', { parentSession: 's1' })
    callers.onClaimed(root, feishu('ou_1'))
    callers.onClaimed(child, { kind: 'subagent' })
    await run('memory_remember', { content: 'note' }, child)
    expect(server.requests[0]?.headers['X-OpenViking-User']).toBe('feishu-ou_1')
    expect(server.requests[0]?.body?.uri).toMatch(/^viking:\/\/user\/feishu-ou_1\/memories\/notes\//u)
  })

  it('declare read tools concurrency safe and render JSON', () => {
    const { tools } = setup()
    expect(tools.get('memory_search')?.isConcurrencySafe?.({})).toBe(true)
    expect(tools.get('memory_remember')?.isConcurrencySafe?.({})).toBe(false)
    expect(tools.get('memory_read')?.output.render({}, { uri: 'u' })).toEqual([{ type: 'text', text: '{\n  "uri": "u"\n}' }])
    expect(tools.get('memory_read')?.parameters).not.toHaveProperty('$schema')
  })
})
