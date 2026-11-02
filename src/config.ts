/**
 * Plugin configuration: where the OpenViking server is, how each DSH caller
 * identity maps to an OpenViking user, and the recall, capture, and tool
 * policies. Validated by the DSH Loader through the exported Standard Schema
 * before `apply()`; an invalid entry fails plugin load.
 *
 * @module dsh-openviking/config
 */

import { z } from 'zod'

/** Characters OpenViking accepts in an account, user, or peer id. */
export const OV_ID_PATTERN = /^[A-Za-z0-9_.@-]{1,128}$/u

/** A credential reference: an environment-variable-style key, never the secret itself. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** `{field}` placeholders of an identity template. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/gu

const templateSchema = z.string().trim().min(1).refine(
  template => OV_ID_PATTERN.test(template.replace(PLACEHOLDER, 'x')),
  'an identity template may contain only A-Z a-z 0-9 _ . @ - and {field} placeholders',
)

const toolPatternSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9_*.-]+$/u, 'a tool pattern may contain letters, digits, _ . - and * wildcards')

const regexSchema = z.string().min(1).refine(value => {
  try {
    return new RegExp(value, 'u').source.includes('(?<peer>')
  } catch {
    // Not a valid regular expression.
    return false
  }
}, 'cwdPattern must be a valid regular expression with a named group (?<peer>...)')

/** The validated `config` of one composition entry. */
export const pluginConfigSchema = z.object({
  /** OpenViking server base URL, e.g. `http://openviking:1933`. */
  endpoint: z.url({ protocol: /^https?$/u }).transform(value => value.replace(/\/+$/u, '')),
  /** OpenViking account every DSH user lives in. */
  account: z.string().regex(OV_ID_PATTERN).default('dsh'),
  /**
   * Credential reference of the server's root API key (trusted mode). It is
   * resolved through the DSH credential store, then the same-named
   * environment variable.
   */
  apiKeyRef: z.string().regex(CREDENTIAL_REF_PATTERN, 'apiKeyRef names a credential (letters, digits, _), it is not the key').default('OPENVIKING_API_KEY'),
  /**
   * DSH principal kind → OpenViking user id template. `{field}` is replaced by
   * that string field of the principal (e.g. `{userId}`); the result must be a
   * valid OpenViking id. The Host owner's kind is `owner`. A turn whose caller
   * has a kind not listed here gets no recall, no capture, and no memory tools.
   */
  identities: z.record(z.string().trim().min(1), templateSchema).default({ owner: 'owner', 'feishu-user': 'feishu-{userId}' }),
  /**
   * Principal kinds whose searches and recall also cover the account's shared
   * resources and whose tools may read any URI the server allows. Every other
   * kind is limited to its own user space.
   */
  sharedReaders: z.array(z.string().trim().min(1)).default(['owner']),
  /**
   * What a user prompt without a principal and without browser correlation
   * means (a terminal or SDK prompt, or a prompt from a surface that does not
   * record its caller): `skip` gives that turn no memory; `owner` treats it as
   * the Host owner.
   */
  unattributedPrompts: z.enum(['skip', 'owner']).default('skip'),
  /**
   * Scope memories within a user by conversation: the named group `peer` of
   * this pattern, matched against the Session's creation directory, becomes
   * the OpenViking actor peer (`prefix` + match). Unmatched Sessions use the
   * user's own space.
   */
  peer: z.object({
    cwdPattern: regexSchema,
    prefix: z.string().regex(/^[A-Za-z0-9_.@-]*$/u).default(''),
  }).optional(),
  /** Give subagent Sessions recall and capture too (they always get the tools, as their root caller). */
  subagents: z.boolean().default(false),
  recall: z.object({
    enabled: z.boolean().default(true),
    /** Most entries injected per step. */
    limit: z.number().int().min(1).max(50).default(6),
    /** Lowest relevance score injected. */
    scoreThreshold: z.number().min(0).max(1).default(0.3),
    /** Shortest user prompt (characters) that triggers recall. */
    minQueryLength: z.number().int().min(1).default(4),
    /** Most characters of injected text per step. */
    maxChars: z.number().int().min(200).max(50_000).default(4_000),
    /** Recall request timeout; a slower server skips recall for that step. */
    timeoutMs: z.number().int().min(100).max(60_000).default(3_000),
  }).prefault({}),
  capture: z.object({
    enabled: z.boolean().default(true),
    /** Capture assistant replies (user prompts are always captured when capture is on). */
    assistant: z.boolean().default(true),
    /**
     * Tool name patterns (`*` wildcard) whose results must never reach
     * memory. Tool results are never captured; a call to one of these tools
     * also stops capturing assistant replies until the turn ends, since they
     * may quote the result.
     */
    toolDeny: z.array(toolPatternSchema).default([]),
    /** Characters captured into one OpenViking session before it is committed (memory extraction). */
    commitAfterChars: z.number().int().min(1_000).default(20_000),
    /** Longest captured message; longer text is cut. */
    maxMessageChars: z.number().int().min(200).default(8_000),
    /** Most writes kept for retry while the server is unreachable; older ones are dropped. */
    pendingMax: z.number().int().min(0).max(10_000).default(500),
  }).prefault({}),
  tools: z.object({
    /** Register the memory tools. */
    enabled: z.boolean().default(true),
  }).prefault({}),
  /** Timeout of every request other than recall. */
  requestTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
})

/** The resolved configuration. */
export type PluginConfig = z.output<typeof pluginConfigSchema>

/**
 * Validate one composition entry's configuration.
 * @param input - the raw `config` value.
 * @returns the resolved configuration.
 * @throws when the configuration is invalid.
 */
export function resolveConfig(input: unknown): PluginConfig {
  return pluginConfigSchema.parse(input)
}
