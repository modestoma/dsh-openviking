/** Test doubles: a fake OpenViking server behind `fetch`, Sessions, and messages. */

import { resolveConfig } from '../src/config.ts'
import type { PluginConfig } from '../src/config.ts'
import type { MessageSource, Session, UserMessage } from '../src/host.ts'

/** One request the fake server received. */
export interface Recorded {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown> | undefined
}

/** A scripted reply: status and envelope. */
export interface Reply {
  readonly status?: number
  readonly body?: unknown
}

/**
 * A fake OpenViking server. `handler` answers each request; the default
 * answers `{ status: 'ok', result: null }`.
 */
export function fakeServer(handler: (request: Recorded) => Reply | Promise<Reply> = () => ({})) {
  const requests: Recorded[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = new URL(String(input))
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key] = value
    const request: Recorded = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined,
    }
    requests.push(request)
    const reply = await handler(request)
    return new Response(JSON.stringify(reply.body ?? { status: 'ok', result: null }), { status: reply.status ?? 200 })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

/** A resolved configuration with test overrides. */
export function testConfig(overrides: Record<string, unknown> = {}): PluginConfig {
  return resolveConfig({ endpoint: 'http://ov.test:1933', ...overrides })
}

/** A root or subagent Session. */
export function session(id: string, header: { cwd?: string; parentSession?: string } = {}): Session {
  return { id, header: { id, ...header } }
}

/** A user message with a text block. */
export function message(text: string, source: MessageSource): UserMessage {
  return { id: `m-${text.slice(0, 8)}`, role: 'user', content: [{ type: 'text', text }], source }
}

/** The source of a prompt from a Feishu user. */
export function feishu(userId: string): MessageSource {
  return { kind: 'user', rpcId: `rpc-${userId}`, principal: { kind: 'feishu-user', userId } }
}

/** The source of a browser prompt from the Host owner. */
export const ownerSource: MessageSource = { kind: 'user', rpcId: 'rpc-owner' }
