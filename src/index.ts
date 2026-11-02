/**
 * dsh-openviking: OpenViking long-term memory for DSH, isolated per caller.
 *
 * Each turn acts for the caller its claimed prompt records (the message
 * source's principal, or the Host owner for a browser prompt); the caller
 * maps to its own OpenViking user, and every request carries that user in
 * `X-OpenViking-User` (trusted mode). Recall searches, capture writes, and
 * the memory tools act only as that user. A turn without a known caller gets
 * none of them.
 *
 * @module dsh-openviking
 */

import { CaptureQueue } from './capture.ts'
import { OpenVikingClient } from './client.ts'
import { pluginConfigSchema, resolveConfig } from './config.ts'
import type { PluginConfig } from './config.ts'
import type { HostContext, PreStepDecision, PreStepPayload } from './host.ts'
import { CallerTracker } from './identity.ts'
import { recallMessage } from './recall.ts'
import { createTools } from './tools.ts'

export { CaptureQueue, matchesToolPattern, ovSessionIdOf } from './capture.ts'
export { OpenVikingClient, OpenVikingError } from './client.ts'
export type { MatchedContext, OpenVikingClientOptions, OvIdentity } from './client.ts'
export { OV_ID_PATTERN, pluginConfigSchema, resolveConfig } from './config.ts'
export type { PluginConfig } from './config.ts'
export { CallerTracker, claimedCallerOf, OWNER, ovUserOf, peerOf } from './identity.ts'
export type { Principal, TurnIdentity } from './identity.ts'
export { promptText, RECALL_SOURCE_KIND, recallMessage, renderRecall, searchRootOf } from './recall.ts'
export { createTools, deletableUri, MemoryToolError, memoriesRootOf, normalizeUri, readableUri, userRootOf } from './tools.ts'

/** Cordis plugin name. */
export const name = 'dsh-openviking'

/** Host services the plugin needs. */
export const inject = ['tools', 'credentials'] as const

/** Loader-validated configuration (Standard Schema). */
export const Config = pluginConfigSchema

/** Test seams of {@link apply}. */
export interface OpenVikingPluginOptions {
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Start the plugin: track callers from claimed prompts, add recall to steps
 * that admit prompts, capture Session events, and register the memory tools.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 * @throws when the configuration is invalid.
 */
export function apply(ctx: HostContext, config?: unknown, options: OpenVikingPluginOptions = {}): void {
  const resolved: PluginConfig = resolveConfig(config)
  const current = () => resolved
  const warn = (message: string, ...args: unknown[]) => { ctx.logger?.warn?.(message, ...args) }
  const client = new OpenVikingClient({
    endpoint: resolved.endpoint,
    account: resolved.account,
    timeoutMs: resolved.requestTimeoutMs,
    apiKey: async () => {
      const credential = await ctx.credentials.resolve(resolved.apiKeyRef)
      if (credential === undefined || credential.value === '') throw new Error(`OpenViking API key ${resolved.apiKeyRef} is not set in the DSH credential store or the environment`)
      return credential.value
    },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
  })
  const callers = new CallerTracker(current)
  const capture = new CaptureQueue({ client, callers, config: current, warn })

  ctx.effect(() => {
    capture.start()
    void ctx.credentials.resolve(resolved.apiKeyRef).then(
      credential => { if (credential === undefined) warn('dsh-openviking: credential %s is not set; recall, capture, and memory tools will fail until it is', resolved.apiKeyRef) },
      (error: unknown) => { warn('dsh-openviking: cannot resolve credential %s: %s', resolved.apiKeyRef, error instanceof Error ? error.message : String(error)) },
    )
    return () => {
      void capture.stop().finally(() => { callers.clear() })
    }
  }, 'dsh-openviking: capture')

  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    callers.onClaimed(agent.session, message.source)
  })

  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const { session } = payload.agent
    callers.onAdmitted(session, decision.messages.map(message => message.source))
    if (session.header.parentSession !== undefined && !resolved.subagents) return decision
    const identity = callers.identityOf(session)
    if (identity === undefined) return decision
    const recall = await recallMessage({ client, config: current, warn }, identity, decision.messages, payload.signal)
    return recall === undefined ? decision : { ...decision, messages: [...decision.messages, recall] }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    capture.onEvent(session, event)
  })

  if (resolved.tools.enabled) {
    for (const definition of createTools({ client, callers, config: current })) {
      ctx.effect(() => ctx.tools.register(definition, {
        when: ({ agent }) => callers.identityOf(agent.session) !== undefined,
      }), `dsh-openviking: ${definition.name}`)
    }
  }
}
