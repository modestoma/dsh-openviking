/**
 * Capture: copy each turn's conversation into an OpenViking session of the
 * user the turn acts for, and commit it so OpenViking extracts memories.
 *
 * - One OpenViking session per (DSH root Session, OpenViking user, peer):
 *   in a Session several users take turns in, each user's turns land in that
 *   user's own session, never in another user's.
 * - Captured: `user` prompts, and assistant replies when `capture.assistant`
 *   is on. Never captured: tool results, context injected by plugins
 *   (including this plugin's recall), and interrupted replies. A call to a
 *   `capture.toolDeny` tool stops capturing assistant replies until the turn
 *   ends, because they may quote the denied tool's result.
 * - A session is committed once `capture.commitAfterChars` characters were
 *   captured since its last commit, when DSH starts compacting the Session,
 *   and (best effort) when the plugin stops.
 * - Writes run one at a time in arrival order. A retryable failure keeps the
 *   write, with the identity it was made for, in a bounded in-memory queue
 *   (`capture.pendingMax`, oldest dropped first) retried every minute and
 *   before later writes of the same session; later writes of that session
 *   queue behind it so order is kept. The queue does not survive a restart.
 *
 * @module dsh-openviking/capture
 */

import { createHash } from 'node:crypto'
import { OpenVikingError } from './client.ts'
import type { OpenVikingClient, OvIdentity } from './client.ts'
import type { PluginConfig } from './config.ts'
import type { Session, SessionEvent } from './host.ts'
import type { CallerTracker } from './identity.ts'

/** One write to an OpenViking session. */
type Write =
  | { readonly kind: 'message'; readonly role: 'user' | 'assistant'; readonly content: string; readonly createdAt: string }
  | { readonly kind: 'commit' }

/** One OpenViking session this process writes to. */
interface OvSession {
  readonly key: string
  readonly identity: OvIdentity
  readonly sessionId: string
  ensured: boolean
  charsSinceCommit: number
  /** Writes of this session wait in the retry queue. */
  latched: boolean
}

/** One write kept for retry. */
interface PendingWrite {
  readonly session: OvSession
  readonly write: Write
}

/** Retry interval of the pending queue. */
const DRAIN_INTERVAL_MS = 60_000

export interface CaptureDeps {
  readonly client: OpenVikingClient
  readonly callers: CallerTracker
  config(): PluginConfig
  warn(message: string, ...args: unknown[]): void
}

/**
 * The OpenViking session id for one DSH Session and identity.
 * @param dshSessionId - the DSH root Session id.
 * @param identity - user and peer.
 * @returns a stable id of at most 128 safe characters.
 */
export function ovSessionIdOf(dshSessionId: string, identity: OvIdentity): string {
  const readable = `dsh-${dshSessionId}-${identity.user}${identity.peer === undefined ? '' : `-${identity.peer}`}`
  if (/^[A-Za-z0-9_.@-]{1,128}$/u.test(readable)) return readable
  return `dsh-${createHash('sha256').update(readable).digest('hex').slice(0, 40)}`
}

/**
 * Whether a tool name matches one `*` pattern.
 * @param name - the tool name.
 * @param pattern - a pattern from `capture.toolDeny`.
 * @returns true on a full match.
 */
export function matchesToolPattern(name: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.\\^$+?()[\]{}|-]/gu, '\\$&')).join('.*')}$`, 'u')
  return regex.test(name)
}

export class CaptureQueue {
  private readonly sessions = new Map<string, OvSession>()
  private pending: PendingWrite[] = []
  /** Root Session ids whose current turn called a denied tool. */
  private readonly tainted = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: CaptureDeps) {}

  /** Start retrying the pending queue periodically. */
  start(): void {
    this.timer ??= setInterval(() => { this.schedule(() => this.drain()) }, DRAIN_INTERVAL_MS)
    this.timer.unref?.()
  }

  /**
   * Stop retrying and commit every session with uncommitted text (best effort, short timeout).
   * @returns when the last write settled.
   */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    for (const session of this.sessions.values()) {
      this.schedule(async () => {
        if (!session.latched) await this.perform(session, { kind: 'commit' }, 3_000).catch((error: unknown) => {
          this.deps.warn('dsh-openviking: final commit for %s failed: %s', session.identity.user, error instanceof Error ? error.message : String(error))
        })
      })
    }
    await this.chain
  }

  /**
   * Observe one durable Session event.
   * @param session - the Session that logged it.
   * @param event - the event.
   */
  onEvent(session: Session, event: SessionEvent): void {
    const config = this.deps.config()
    if (!config.capture.enabled) return
    if (session.header.parentSession !== undefined && !config.subagents) return
    const root = this.deps.callers.rootOf(session.id)
    switch (event.type) {
      case 'tool/call': {
        const { name } = (event as Extract<SessionEvent, { type: 'tool/call' }>).data
        if (config.capture.toolDeny.some(pattern => matchesToolPattern(name, pattern))) this.tainted.add(root)
        return
      }
      case 'turn/end':
        this.tainted.delete(root)
        return
      case 'compaction/start':
        this.commitFor(session, root)
        return
      case 'user/message': {
        const message = (event as Extract<SessionEvent, { type: 'user/message' }>).data
        if (message.source.kind !== 'user') return
        this.capture(session, root, 'user', textOf(message.content))
        return
      }
      case 'assistant/message': {
        const data = (event as Extract<SessionEvent, { type: 'assistant/message' }>).data
        if (!config.capture.assistant || data.interrupted === true || this.tainted.has(root)) return
        this.capture(session, root, 'assistant', textOf(data.message.content))
        return
      }
      default:
        // Other event types carry nothing to capture.
        return
    }
  }

  /** Wait until every scheduled write settled (tests and `session/flush`). */
  async idle(): Promise<void> {
    await this.chain
  }

  /** Writes waiting for retry. */
  pendingCount(): number {
    return this.pending.length
  }

  private capture(session: Session, root: string, role: 'user' | 'assistant', text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    const target = this.sessionFor(session, root)
    if (target === undefined) return
    const { maxMessageChars } = this.deps.config().capture
    const content = trimmed.length > maxMessageChars ? `${trimmed.slice(0, maxMessageChars)}…` : trimmed
    this.enqueue(target, { kind: 'message', role, content, createdAt: new Date().toISOString() })
  }

  private commitFor(session: Session, root: string): void {
    const target = this.sessionFor(session, root)
    if (target !== undefined) this.enqueue(target, { kind: 'commit' })
  }

  private sessionFor(session: Session, root: string): OvSession | undefined {
    const identity = this.deps.callers.identityOf(session)
    if (identity === undefined) return undefined
    const plain: OvIdentity = { user: identity.user, ...identity.peer === undefined ? {} : { peer: identity.peer } }
    const key = `${root}\u0000${plain.user}\u0000${plain.peer ?? ''}`
    let target = this.sessions.get(key)
    if (target === undefined) {
      target = { key, identity: plain, sessionId: ovSessionIdOf(root, plain), ensured: false, charsSinceCommit: 0, latched: false }
      this.sessions.set(key, target)
    }
    return target
  }

  private enqueue(session: OvSession, write: Write): void {
    this.schedule(async () => {
      if (session.latched) await this.drain()
      if (session.latched) {
        this.keep(session, write)
        return
      }
      await this.attempt(session, write)
    })
  }

  private schedule(operation: () => Promise<void>): void {
    this.chain = this.chain.then(operation).catch((error: unknown) => {
      this.deps.warn('dsh-openviking: capture failed: %s', error instanceof Error ? error.message : String(error))
    })
  }

  /** Perform one write; keep it for retry on a retryable failure, drop it otherwise. */
  private async attempt(session: OvSession, write: Write): Promise<boolean> {
    try {
      await this.perform(session, write)
      return true
    } catch (error) {
      if (error instanceof OpenVikingError && error.retryable) {
        session.latched = true
        this.keep(session, write)
      } else {
        this.deps.warn('dsh-openviking: dropped a capture write for %s: %s', session.identity.user, error instanceof Error ? error.message : String(error))
      }
      return false
    }
  }

  /** Perform one write; a commit with nothing captured since the last one is a no-op. */
  private async perform(session: OvSession, write: Write, timeoutMs?: number): Promise<void> {
    if (write.kind === 'commit' && session.charsSinceCommit === 0) return
    if (!session.ensured) {
      await this.deps.client.ensureSession(session.identity, session.sessionId)
      session.ensured = true
    }
    if (write.kind === 'commit') {
      await this.deps.client.commit(session.identity, session.sessionId, timeoutMs)
      session.charsSinceCommit = 0
      return
    }
    await this.deps.client.addMessage(session.identity, session.sessionId, write)
    session.charsSinceCommit += write.content.length
    if (session.charsSinceCommit >= this.deps.config().capture.commitAfterChars) {
      await this.deps.client.commit(session.identity, session.sessionId)
      session.charsSinceCommit = 0
    }
  }

  private keep(session: OvSession, write: Write): void {
    const { pendingMax } = this.deps.config().capture
    this.pending.push({ session, write })
    while (this.pending.length > pendingMax) {
      const dropped = this.pending.shift()
      if (dropped !== undefined) this.deps.warn('dsh-openviking: retry queue full, dropped a capture write for %s', dropped.session.identity.user)
    }
    this.refreshLatches()
  }

  /** Retry pending writes in order, stopping at the first one that still fails. */
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const next = this.pending[0]!
      try {
        await this.perform(next.session, next.write)
      } catch (error) {
        if (error instanceof OpenVikingError && error.retryable) break
        this.deps.warn('dsh-openviking: dropped a capture write for %s: %s', next.session.identity.user, error instanceof Error ? error.message : String(error))
      }
      this.pending.shift()
    }
    this.refreshLatches()
  }

  private refreshLatches(): void {
    const waiting = new Set(this.pending.map(entry => entry.session.key))
    for (const session of this.sessions.values()) session.latched = waiting.has(session.key)
  }
}

function textOf(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n')
}
