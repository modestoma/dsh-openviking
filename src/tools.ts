/**
 * Memory tools: let the model search, read, list, add, and delete long-term
 * memory as the user the current turn acts for.
 *
 * - The tools are offered only while the turn has an OpenViking identity
 *   (see `identity.ts`), so a turn without one cannot reach any user's data.
 * - Every URI is checked before the request: it must be a `viking://` URI
 *   without `.`/`..` segments, percent escapes, or backslashes. A caller
 *   outside `sharedReaders` may read, list, and search only its own user
 *   space `viking://user/<user>/`; a shared reader may read anything the
 *   server allows.
 * - `memory_remember` writes a new file under the caller's own
 *   `viking://user/<user>/memories/notes/`; `memory_forget` deletes one file
 *   under the caller's own `viking://user/<user>/memories/`. No caller can
 *   write or delete elsewhere, shared readers included.
 * - A failure throws with its cause in brackets, e.g. `[forbidden] …`.
 *
 * @module dsh-openviking/tools
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OpenVikingClient } from './client.ts'
import type { PluginConfig } from './config.ts'
import type { ContentBlock, ToolDefinition, ToolRunContext } from './host.ts'
import type { CallerTracker, TurnIdentity } from './identity.ts'
import { searchRootOf } from './recall.ts'

/** Collaborators of the tool set. */
export interface ToolDeps {
  readonly client: OpenVikingClient
  readonly callers: CallerTracker
  config(): PluginConfig
  /** Current time, for note file names. */
  now?(): Date
}

/** A rejected tool call. */
export class MemoryToolError extends Error {
  override readonly name = 'MemoryToolError'
  constructor(readonly code: 'forbidden' | 'invalid' | 'no-identity', message: string) {
    super(`[${code}] ${message}`)
  }
}

/**
 * The caller's own user space.
 * @param identity - the caller.
 * @returns `viking://user/<user>/`.
 */
export function userRootOf(identity: Pick<TurnIdentity, 'user'>): string {
  return `viking://user/${identity.user}/`
}

/**
 * The directory the caller's memories live in.
 * @param identity - the caller.
 * @returns `viking://user/<user>/memories/`.
 */
export function memoriesRootOf(identity: Pick<TurnIdentity, 'user'>): string {
  return `${userRootOf(identity)}memories/`
}

/**
 * Normalize a `viking://` URI and reject one that could escape a prefix check.
 * @param uri - the URI the model passed.
 * @returns the URI without a trailing slash (`viking://` itself stays as is).
 * @throws {MemoryToolError} `invalid` for anything else.
 */
export function normalizeUri(uri: string): string {
  const trimmed = uri.trim()
  if (!trimmed.startsWith('viking://')) throw new MemoryToolError('invalid', `不是 viking:// URI：${uri}`)
  if (/[\\%\u0000-\u001f]/u.test(trimmed)) throw new MemoryToolError('invalid', `URI 不能包含反斜杠、百分号转义或控制字符：${uri}`)
  const path = trimmed.slice('viking://'.length)
  const segments = path.split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment === '.' || segment === '..')) throw new MemoryToolError('invalid', `URI 不能包含 . 或 .. 段：${uri}`)
  return `viking://${segments.join('/')}`
}

/**
 * Whether a normalized URI is the directory `root` or inside it.
 * @param uri - a URI from {@link normalizeUri}.
 * @param root - a directory URI ending in `/`.
 * @returns true when inside.
 */
export function isWithin(uri: string, root: string): boolean {
  return `${uri}/`.startsWith(root)
}

/**
 * Check that the caller may read a URI.
 * @param identity - the caller.
 * @param uri - the URI the model passed.
 * @returns the normalized URI.
 * @throws {MemoryToolError} `forbidden` outside the caller's space for a non-shared reader.
 */
export function readableUri(identity: TurnIdentity, uri: string): string {
  const normalized = normalizeUri(uri)
  if (!identity.sharedReader && !isWithin(normalized, userRootOf(identity))) {
    throw new MemoryToolError('forbidden', `只能读取自己的记忆空间 ${userRootOf(identity)}，不能读取 ${normalized}`)
  }
  return normalized
}

/**
 * Check that the caller may delete a URI.
 * @param identity - the caller.
 * @param uri - the URI the model passed.
 * @returns the normalized URI.
 * @throws {MemoryToolError} `forbidden` outside the caller's own memories, or on the memories directory itself.
 */
export function deletableUri(identity: TurnIdentity, uri: string): string {
  const normalized = normalizeUri(uri)
  const root = memoriesRootOf(identity)
  if (!isWithin(normalized, root) || `${normalized}/` === root) {
    throw new MemoryToolError('forbidden', `只能删除自己 ${root} 下的单个记忆文件，不能删除 ${normalized}`)
  }
  return normalized
}

/**
 * A file name for a new note.
 * @param title - the model's title, or undefined.
 * @param now - the current time.
 * @returns `<timestamp>[-<slug>]-<random>.md` with only safe characters, unique per call.
 */
export function noteFileName(title: string | undefined, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  const slug = (title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  // Always suffixed: two notes with one title in one second must not overwrite each other.
  const unique = randomUUID().slice(0, 8)
  return /^[A-Za-z0-9-]+$/u.test(slug) ? `${stamp}-${slug}-${unique}.md` : `${stamp}-${unique}.md`
}

interface Spec<S extends z.ZodType, V> {
  readonly name: string
  readonly description: string
  readonly schema: S
  readonly readOnly: boolean
  run(identity: TurnIdentity, args: z.output<S>, signal: AbortSignal): Promise<V>
}

/**
 * Build the memory tool definitions.
 * @param deps - client, caller tracker, configuration.
 * @returns the tools; the plugin registers each one while the turn has an identity.
 */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { client } = deps
  const now = () => deps.now?.() ?? new Date()
  return [
    define(deps, {
      name: 'memory_search',
      description: '在长期记忆里做语义检索，返回相关条目的 URI、摘要和相关度。用户提到以前说过的事、偏好、约定，或你需要过往背景时使用。',
      schema: z.object({
        query: z.string().trim().min(1).describe('要检索的内容，用自然语言描述'),
        limit: z.number().int().min(1).max(20).optional().describe('最多返回几条，默认 8'),
      }).strict(),
      readOnly: true,
      run: async (identity, args, signal) => {
        const targetUri = searchRootOf(identity)
        const results = await client.find(identity, args.query, {
          limit: args.limit ?? 8,
          scoreThreshold: 0,
          signal,
          ...targetUri === undefined ? {} : { targetUri },
        })
        return { results: results.filter(entry => identity.sharedReader || isWithin(safeNormalize(entry.uri), userRootOf(identity))) }
      },
    }),
    define(deps, {
      name: 'memory_read',
      description: '读取一条长期记忆或资料的全文（memory_search、memory_list 或召回块里给出的 viking:// URI）。',
      schema: z.object({ uri: z.string().min(1).describe('viking:// URI') }).strict(),
      readOnly: true,
      run: async (identity, args, signal) => {
        const uri = readableUri(identity, args.uri)
        const content = await client.read(identity, uri, signal)
        if (typeof content !== 'string') throw new MemoryToolError('invalid', `${uri} 不是文本文件`)
        return { uri, content }
      },
    }),
    define(deps, {
      name: 'memory_list',
      description: '列出长期记忆中一个目录的内容；不给 uri 时列出自己的记忆目录。',
      schema: z.object({ uri: z.string().min(1).optional().describe('viking:// 目录 URI，默认是自己的记忆目录') }).strict(),
      readOnly: true,
      run: async (identity, args, signal) => {
        const uri = args.uri === undefined ? normalizeUri(memoriesRootOf(identity)) : readableUri(identity, args.uri)
        const entries = await client.list(identity, uri, signal)
        return { uri, entries: entries.map(entryOf) }
      },
    }),
    define(deps, {
      name: 'memory_remember',
      description: '把一条值得长期记住的信息写进当前用户自己的记忆（例如用户明确要求记住的偏好、约定、事实）。不要写入密码、密钥等机密，也不要写入从受限知识库读到的内容。',
      schema: z.object({
        content: z.string().trim().min(1).max(20_000).describe('要记住的内容，写成独立可读的一段话'),
        title: z.string().trim().max(80).optional().describe('简短标题，用于文件名'),
      }).strict(),
      readOnly: false,
      run: async (identity, args, signal) => {
        const uri = `${memoriesRootOf(identity)}notes/${noteFileName(args.title, now())}`
        const body = args.title === undefined ? args.content : `# ${args.title}\n\n${args.content}`
        await client.write(identity, uri, `${body}\n`, signal)
        return { uri }
      },
    }),
    define(deps, {
      name: 'memory_forget',
      description: '删除当前用户自己记忆目录下的一个记忆文件（用户要求忘掉某件事，或记忆已过时）。',
      schema: z.object({ uri: z.string().min(1).describe('要删除的记忆文件 viking:// URI') }).strict(),
      readOnly: false,
      run: async (identity, args, signal) => {
        const uri = deletableUri(identity, args.uri)
        await client.remove(identity, uri, signal)
        return { uri, deleted: true }
      },
    }),
  ]
}

function define<S extends z.ZodType, V>(deps: ToolDeps, spec: Spec<S, V>): ToolDefinition<V> {
  const parameters = z.toJSONSchema(spec.schema, { target: 'draft-2020-12' }) as Record<string, unknown>
  delete parameters.$schema
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => render(value) },
    isConcurrencySafe: () => spec.readOnly,
    execute: async (raw: unknown, exec: ToolRunContext): Promise<V> => {
      const parsed = spec.schema.safeParse(raw)
      if (!parsed.success) {
        throw new MemoryToolError('invalid', `${spec.name} 参数不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`)
      }
      const identity = exec.agent === undefined ? undefined : deps.callers.identityOf(exec.agent.session)
      if (identity === undefined) throw new MemoryToolError('no-identity', `${spec.name} 只能在能确定调用者身份的会话里使用`)
      return await spec.run(identity, parsed.data, exec.signal)
    },
  }
}

function render(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function safeNormalize(uri: string): string {
  try {
    return normalizeUri(uri)
  } catch {
    // A malformed URI from the server cannot be inside the caller's space.
    return ''
  }
}

function entryOf(entry: unknown): { uri?: string; name?: string; isDir?: boolean; abstract?: string } {
  if (typeof entry === 'string') return { uri: entry }
  if (typeof entry !== 'object' || entry === null) return {}
  const { uri, name, isDir, is_dir: isDirSnake, abstract } = entry as Record<string, unknown>
  const dir = typeof isDir === 'boolean' ? isDir : typeof isDirSnake === 'boolean' ? isDirSnake : undefined
  return {
    ...typeof uri === 'string' ? { uri } : {},
    ...typeof name === 'string' ? { name } : {},
    ...dir === undefined ? {} : { isDir: dir },
    ...typeof abstract === 'string' && abstract !== '' ? { abstract } : {},
  }
}
