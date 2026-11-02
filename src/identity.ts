/**
 * Who a turn acts for, read from the durable Session log.
 *
 * DSH records the caller of a prompt in its message source: a browser prompt
 * from the Host owner is `{ kind: 'user', rpcId }`, a prompt from any other
 * caller adds `principal: { kind, ... }` (e.g. `{ kind: 'feishu-user',
 * userId }`). Each claimed prompt names the caller of the turn it opens:
 *
 * - a `user` prompt with a principal → that principal;
 * - a `user` prompt with `rpcId` and no principal → the Host owner;
 * - a `user` prompt with neither → per `unattributedPrompts`: no caller
 *   (`skip`) or the Host owner (`owner`);
 * - any other message (subagent results, jobs, schedules, command
 *   expansions without a principal) keeps the previous caller.
 *
 * A subagent Session acts for its root Session's current caller. The caller
 * maps to an OpenViking user through the `identities` templates; a principal
 * kind without a template, or a template whose result is not a valid
 * OpenViking id, gives no identity, so nothing is recalled, captured, or
 * reachable through the tools (fail closed).
 *
 * Callers are kept in memory: after a restart, a Session has no caller until
 * its next claimed prompt.
 *
 * @module dsh-openviking/identity
 */

import { OV_ID_PATTERN } from './config.ts'
import type { PluginConfig } from './config.ts'
import type { OvIdentity } from './client.ts'
import type { MessageSource, Session } from './host.ts'

/** A DSH caller identity: a JSON object with a string `kind`. */
export interface Principal {
  readonly kind: string
  readonly [field: string]: unknown
}

/** The Host owner's principal. */
export const OWNER: Principal = { kind: 'owner' }

/** Who a turn acts for, resolved to OpenViking. */
export interface TurnIdentity extends OvIdentity {
  /** The DSH principal kind. */
  readonly kind: string
  /** Whether this caller may read the account's shared resources. */
  readonly sharedReader: boolean
}

/** What one claimed message says about the caller. */
type ClaimedCaller = { readonly kind: 'set'; readonly principal: Principal | undefined } | { readonly kind: 'keep' }

/**
 * Read the caller one claimed message names.
 * @param source - the message source (durable log data, validated here).
 * @param unattributed - the `unattributedPrompts` policy.
 * @returns the caller to set, or `keep` for a message that names none.
 */
export function claimedCallerOf(source: MessageSource, unattributed: PluginConfig['unattributedPrompts']): ClaimedCaller {
  if (source.kind !== 'user') return { kind: 'keep' }
  const principal = source.principal
  if (principal !== undefined) {
    const valid = typeof principal === 'object' && principal !== null && typeof (principal as { kind?: unknown }).kind === 'string'
    // A malformed principal names an unknown caller: no identity.
    return { kind: 'set', principal: valid ? principal as Principal : undefined }
  }
  if (typeof source.rpcId === 'string') return { kind: 'set', principal: OWNER }
  return { kind: 'set', principal: unattributed === 'owner' ? OWNER : undefined }
}

/**
 * Map one principal to its OpenViking user.
 * @param principal - the caller.
 * @param config - `identities` and `sharedReaders`.
 * @returns the OpenViking user, or undefined when the kind has no template or the result is invalid.
 */
export function ovUserOf(principal: Principal, config: Pick<PluginConfig, 'identities'>): string | undefined {
  const template = Object.hasOwn(config.identities, principal.kind) ? config.identities[principal.kind] : undefined
  if (template === undefined) return undefined
  let missing = false
  const user = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, field: string) => {
    const value = principal[field]
    if (typeof value !== 'string' || value === '') {
      missing = true
      return ''
    }
    return value
  })
  return !missing && OV_ID_PATTERN.test(user) ? user : undefined
}

/**
 * The actor peer a Session's creation directory names.
 * @param cwd - the Session header `cwd`.
 * @param peer - the `peer` configuration.
 * @returns the peer id, or undefined when unconfigured, unmatched, or invalid.
 */
export function peerOf(cwd: string | undefined, peer: PluginConfig['peer']): string | undefined {
  if (peer === undefined || cwd === undefined) return undefined
  const match = new RegExp(peer.cwdPattern, 'u').exec(cwd)?.groups?.peer
  if (match === undefined || match === '') return undefined
  const id = `${peer.prefix}${match}`
  return OV_ID_PATTERN.test(id) ? id : undefined
}

/** Tracks the caller of every Session's current turn. */
export class CallerTracker {
  /** Session id → caller of its current turn (undefined = no identity). */
  private readonly callers = new Map<string, Principal | undefined>()
  /** Session id → header, for subagent parents and peers. */
  private readonly headers = new Map<string, Session['header']>()

  constructor(private readonly config: () => PluginConfig) {}

  /**
   * A turn claimed one message.
   * @param session - the claiming Session.
   * @param source - the claimed message's source.
   */
  onClaimed(session: Session, source: MessageSource): void {
    this.observe(session)
    const caller = claimedCallerOf(source, this.config().unattributedPrompts)
    if (caller.kind === 'set') this.callers.set(session.id, caller.principal)
  }

  /**
   * Who the Session's current turn acts for.
   * @param session - the Session, or a subagent of a Session this tracker saw.
   * @returns the OpenViking identity, or undefined when there is none.
   */
  identityOf(session: Session): TurnIdentity | undefined {
    this.observe(session)
    const root = this.rootOf(session.id)
    const principal = this.callers.get(root)
    if (principal === undefined) return undefined
    const config = this.config()
    const user = ovUserOf(principal, config)
    if (user === undefined) return undefined
    const peer = peerOf(this.headers.get(root)?.cwd, config.peer)
    return { kind: principal.kind, user, ...peer === undefined ? {} : { peer }, sharedReader: config.sharedReaders.includes(principal.kind) }
  }

  /**
   * The root Session of a subagent chain this tracker saw.
   * @param sessionId - any Session id.
   * @returns the outermost ancestor id, or the id itself.
   */
  rootOf(sessionId: string): string {
    const seen = new Set<string>()
    let current = sessionId
    for (;;) {
      const parent = this.headers.get(current)?.parentSession
      if (parent === undefined || seen.has(parent)) return current
      seen.add(current)
      current = parent
    }
  }

  /** Forget a Session (it ended). */
  forget(sessionId: string): void {
    this.callers.delete(sessionId)
    this.headers.delete(sessionId)
  }

  /** Forget everything (shutdown). */
  clear(): void {
    this.callers.clear()
    this.headers.clear()
  }

  /**
   * Remember a Session's header, so its subagents resolve to their root.
   * @param session - any Session.
   */
  observe(session: Session): void {
    if (!this.headers.has(session.id)) this.headers.set(session.id, session.header)
  }
}
