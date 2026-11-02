import { describe, expect, it } from 'vitest'
import { OpenVikingClient, OpenVikingError } from '../src/client.ts'
import { fakeServer } from './helpers.ts'

function clientOf(server: ReturnType<typeof fakeServer>) {
  return new OpenVikingClient({ endpoint: 'http://ov.test:1933', account: 'acme', apiKey: async () => 'root-key', timeoutMs: 1000, fetch: server.fetch })
}

describe('OpenVikingClient', () => {
  it('sends the trusted-mode identity headers on every request', async () => {
    const server = fakeServer()
    await clientOf(server).addMessage({ user: 'feishu-ou_1', peer: 'chat-1' }, 's/1', { role: 'user', content: 'hi', createdAt: '2026-11-02T00:00:00.000Z' })
    const [request] = server.requests
    expect(request?.path).toBe('/api/v1/sessions/s%2F1/messages')
    expect(request?.headers).toMatchObject({
      'X-API-Key': 'root-key',
      'X-OpenViking-Account': 'acme',
      'X-OpenViking-User': 'feishu-ou_1',
      'X-OpenViking-Actor-Peer': 'chat-1',
    })
    expect(request?.body).toEqual({ role: 'user', content: 'hi', created_at: '2026-11-02T00:00:00.000Z', peer_id: 'chat-1' })
  })

  it('omits the peer header without a peer', async () => {
    const server = fakeServer()
    await clientOf(server).commit({ user: 'owner' }, 's1')
    expect(server.requests[0]?.headers['X-OpenViking-Actor-Peer']).toBeUndefined()
    expect(server.requests[0]?.body).toEqual({ keep_recent_count: 0 })
  })

  it('merges and sorts find results across groups', async () => {
    const server = fakeServer(() => ({
      body: {
        status: 'ok',
        result: {
          memories: [{ uri: 'viking://user/u/memories/a.md', abstract: 'A', score: 0.5 }, { abstract: 'no uri' }],
          resources: [{ uri: 'viking://resources/r.md', score: 0.9 }],
          skills: 'not a list',
        },
      },
    }))
    const results = await clientOf(server).find({ user: 'u' }, 'q', { limit: 3, scoreThreshold: 0.2, targetUri: 'viking://user/u/' })
    expect(results).toEqual([
      { uri: 'viking://resources/r.md', abstract: '', score: 0.9 },
      { uri: 'viking://user/u/memories/a.md', abstract: 'A', score: 0.5 },
    ])
    expect(server.requests[0]?.body).toEqual({ query: 'q', limit: 3, score_threshold: 0.2, target_uri: 'viking://user/u/' })
  })

  it('reports error envelopes, statuses, and network failures', async () => {
    const envelope = clientOf(fakeServer(() => ({ status: 200, body: { status: 'error', error: { code: 'NOT_FOUND', message: 'gone' } } })))
    await expect(envelope.read({ user: 'u' }, 'viking://user/u/x')).rejects.toMatchObject({ status: 200, code: 'NOT_FOUND', retryable: false })
    const proxy = new OpenVikingClient({
      endpoint: 'http://ov.test',
      account: 'a',
      apiKey: async () => 'k',
      timeoutMs: 1000,
      fetch: (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch,
    })
    await expect(proxy.list({ user: 'u' }, 'viking://user/u/')).rejects.toMatchObject({ status: 502, retryable: true })
    const down = new OpenVikingClient({
      endpoint: 'http://ov.test',
      account: 'a',
      apiKey: async () => 'k',
      timeoutMs: 1000,
      fetch: (async () => { throw new TypeError('connect ECONNREFUSED') }) as typeof fetch,
    })
    const error = await down.write({ user: 'u' }, 'viking://user/u/x', 'y').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OpenVikingError)
    expect((error as OpenVikingError).retryable).toBe(true)
    expect(new OpenVikingError('m', 429, undefined).retryable).toBe(true)
  })

  it('treats an existing session as created', async () => {
    const client = clientOf(fakeServer(() => ({ status: 409, body: { status: 'error', error: { code: 'ALREADY_EXISTS', message: 'exists' } } })))
    await expect(client.ensureSession({ user: 'u' }, 's1')).resolves.toBeUndefined()
    const failing = clientOf(fakeServer(() => ({ status: 500 })))
    await expect(failing.ensureSession({ user: 'u' }, 's1')).rejects.toBeInstanceOf(OpenVikingError)
  })

  it('returns an empty list for a non-list ls result', async () => {
    const client = clientOf(fakeServer(() => ({ body: { status: 'ok', result: { entries: [] } } })))
    await expect(client.list({ user: 'u' }, 'viking://user/u/')).resolves.toEqual([])
  })
})
