/**
 * Minimal structural declarations of the DSH host interfaces this plugin uses.
 *
 * Only the fields the plugin reads or calls are declared; nothing from
 * `@deepseek-ai/dsh-*` is imported at run time. Field meanings follow the DSH
 * source (`packages/core/agent`, `packages/core/session`, `packages/core/tools`,
 * `packages/llm/llm`, `packages/credentials/credentials`).
 *
 * @module dsh-openviking/host
 */

/** One content block of a message. */
export interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

/** One message source; `kind` names the producer, other fields are producer-specific. */
export interface MessageSource {
  readonly kind: string
  readonly [key: string]: unknown
}

/** One user-role message. */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

/** One model-produced assistant message. */
export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: readonly ContentBlock[]
}

/** The immutable Session header fields this plugin reads. */
export interface SessionHeader {
  readonly id: string
  readonly cwd?: string
  /** The calling parent Session of a subagent child. */
  readonly parentSession?: string
}

/** A live Session. */
export interface Session {
  readonly id: string
  readonly header: SessionHeader
}

/** One durable Session event (the subset this plugin reads; other types pass through). */
export type SessionEvent =
  | { readonly type: 'user/message'; readonly data: UserMessage }
  | { readonly type: 'assistant/message'; readonly data: { readonly turn: number; readonly message: AssistantMessage; readonly interrupted?: true } }
  | { readonly type: 'tool/call'; readonly data: { readonly turn: number; readonly callId: string; readonly name: string } }
  | { readonly type: 'turn/end'; readonly data: { readonly turn: number } }
  | { readonly type: 'compaction/start'; readonly data?: unknown }
  | { readonly type: Exclude<string, 'user/message' | 'assistant/message' | 'tool/call' | 'turn/end' | 'compaction/start'>; readonly data?: unknown }

/** A live Agent. */
export interface Agent {
  readonly session: Session
}

/** Decision of the `agent/pre-step` waterfall. */
export type PreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: readonly UserMessage[]; readonly startsRequestSeries?: true }

/** Payload of `agent/pre-step`. */
export interface PreStepPayload {
  readonly agent: Agent
  readonly messages: readonly UserMessage[]
  readonly signal: AbortSignal
}

/** Payload of `agent/inbox/claimed`. */
export interface InboxClaimedPayload {
  readonly agent: Agent
  readonly message: UserMessage
}

/** Per-call execution context handed to a tool's `execute`. */
export interface ToolRunContext {
  readonly signal: AbortSignal
  readonly agent?: Agent
}

/** Canonical output declaration of one tool. */
export interface ToolOutputDefinition<V> {
  readonly schema: Record<string, unknown>
  render(args: unknown, value: V): ContentBlock[]
}

/** One raw JSON-schema tool registration. */
export interface ToolDefinition<V = unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutputDefinition<V>
  execute(args: unknown, exec: ToolRunContext): Promise<V>
  isConcurrencySafe?(args: unknown): boolean
}

/** The step a tool's activation condition is evaluated for. */
export interface ToolActivationContext {
  readonly agent: Agent
}

/** The `ctx.tools` registry slice. */
export interface ToolRegistry {
  register<V>(
    definition: ToolDefinition<V>,
    options?: { when?: (context: ToolActivationContext) => boolean | Promise<boolean> },
  ): () => void
}

/** The `ctx.credentials` slice: a reference resolves from the DSH credential store or the same-named environment variable. */
export interface HostCredentials {
  resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>
}

/** Cordis logger slice. */
export interface HostLogger {
  info?(message: string, ...args: unknown[]): void
  warn?(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** The plugin context slice this plugin uses. */
export interface HostContext {
  readonly tools: ToolRegistry
  readonly credentials: HostCredentials
  readonly logger?: HostLogger
  effect(callback: () => (() => void) | void, label?: string): () => unknown
  on(name: 'agent/inbox/claimed', listener: (payload: InboxClaimedPayload) => void): () => void
  on(
    name: 'agent/pre-step',
    listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
    options: { prepend: true },
  ): () => void
  on(name: 'session/event', listener: (session: Session, event: SessionEvent) => void): () => void
}
