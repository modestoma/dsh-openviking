/**
 * OpenViking HTTP client for trusted mode: every request carries the root API
 * key plus the account, the user, and optionally the actor peer it acts for,
 * so one client serves every DSH user without sharing state between them.
 *
 * Responses use OpenViking's envelope `{ status, result, error }`; a non-2xx
 * status or an error envelope rejects with {@link OpenVikingError}.
 *
 * @module dsh-openviking/client
 */

/** Who one request acts for. */
export interface OvIdentity {
  readonly user: string
  /** Actor peer that scopes memories within the user. */
  readonly peer?: string
}

/** One retrieved entry. */
export interface MatchedContext {
  readonly uri: string
  readonly abstract: string
  readonly score: number
}

/** A failed OpenViking request. */
export class OpenVikingError extends Error {
  override readonly name = 'OpenVikingError'
  constructor(
    message: string,
    /** HTTP status, or undefined when the request never got a response. */
    readonly status: number | undefined,
    /** OpenViking error code, e.g. `ALREADY_EXISTS`. */
    readonly code: string | undefined,
  ) {
    super(message)
  }

  /** Whether retrying later can succeed (no response, timeout, or a 5xx/429 status). */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500
  }
}

export interface OpenVikingClientOptions {
  readonly endpoint: string
  readonly account: string
  /** Resolves the root API key for each request, so a rotated key applies at once. */
  apiKey(): Promise<string>
  readonly timeoutMs: number
  readonly fetch?: typeof globalThis.fetch
}

interface RequestOptions {
  readonly query?: Record<string, string | number | boolean | undefined>
  readonly body?: unknown
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export class OpenVikingClient {
  private readonly fetch: typeof globalThis.fetch

  constructor(private readonly options: OpenVikingClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  /**
   * Semantic retrieval.
   * @param identity - who searches.
   * @param query - the search text.
   * @param options - result limit, score floor, optional target URI, timeout.
   * @returns memories, resources, and skills in one list, highest score first.
   */
  async find(
    identity: OvIdentity,
    query: string,
    options: { limit: number; scoreThreshold: number; targetUri?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<MatchedContext[]> {
    const result = await this.request<Record<string, unknown>>(identity, 'POST', '/api/v1/search/find', {
      body: { query, limit: options.limit, score_threshold: options.scoreThreshold, ...options.targetUri === undefined ? {} : { target_uri: options.targetUri } },
      ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    const entries: MatchedContext[] = []
    for (const group of ['memories', 'resources', 'skills']) {
      const items = result?.[group]
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (typeof item !== 'object' || item === null) continue
        const { uri, abstract, score } = item as Record<string, unknown>
        if (typeof uri !== 'string') continue
        entries.push({ uri, abstract: typeof abstract === 'string' ? abstract : '', score: typeof score === 'number' ? score : 0 })
      }
    }
    return entries.sort((left, right) => right.score - left.score)
  }

  /**
   * Read a text file.
   * @returns the file text.
   */
  read(identity: OvIdentity, uri: string, signal?: AbortSignal): Promise<string> {
    return this.request<string>(identity, 'GET', '/api/v1/content/read', { query: { uri, offset: 0, limit: -1 }, ...signal === undefined ? {} : { signal } })
  }

  /**
   * List a directory.
   * @returns the raw entries.
   */
  async list(identity: OvIdentity, uri: string, signal?: AbortSignal): Promise<unknown[]> {
    const result = await this.request<unknown>(identity, 'GET', '/api/v1/fs/ls', { query: { uri, simple: false, recursive: false }, ...signal === undefined ? {} : { signal } })
    return Array.isArray(result) ? result : []
  }

  /** Write a text file, creating it. */
  async write(identity: OvIdentity, uri: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.request(identity, 'POST', '/api/v1/content/write', { body: { uri, content }, ...signal === undefined ? {} : { signal } })
  }

  /** Delete one file. */
  async remove(identity: OvIdentity, uri: string, signal?: AbortSignal): Promise<void> {
    await this.request(identity, 'DELETE', '/api/v1/fs', { query: { uri, recursive: false }, ...signal === undefined ? {} : { signal } })
  }

  /** Create a session; an existing one is fine. */
  async ensureSession(identity: OvIdentity, sessionId: string): Promise<void> {
    try {
      await this.request(identity, 'POST', '/api/v1/sessions', { body: { session_id: sessionId } })
    } catch (error) {
      if (error instanceof OpenVikingError && (error.status === 409 || error.code === 'ALREADY_EXISTS')) return
      throw error
    }
  }

  /** Append one message to a session. */
  async addMessage(identity: OvIdentity, sessionId: string, message: { role: 'user' | 'assistant'; content: string; createdAt?: string }): Promise<void> {
    await this.request(identity, 'POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      body: {
        role: message.role,
        content: message.content,
        ...message.createdAt === undefined ? {} : { created_at: message.createdAt },
        ...identity.peer === undefined ? {} : { peer_id: identity.peer },
      },
    })
  }

  /** Commit a session: OpenViking archives it and extracts memories. */
  async commit(identity: OvIdentity, sessionId: string, timeoutMs?: number): Promise<void> {
    await this.request(identity, 'POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
      body: { keep_recent_count: 0 },
      ...timeoutMs === undefined ? {} : { timeoutMs },
    })
  }

  private async request<T>(identity: OvIdentity, method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.options.endpoint}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {
      'X-API-Key': await this.options.apiKey(),
      'X-OpenViking-Account': this.options.account,
      'X-OpenViking-User': identity.user,
    }
    if (identity.peer !== undefined) headers['X-OpenViking-Actor-Peer'] = identity.peer
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
    let response: Response
    try {
      response = await this.fetch(url, {
        method,
        headers,
        ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
        signal,
      })
    } catch (error) {
      throw new OpenVikingError(`OpenViking ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`, undefined, undefined)
    }
    const text = await response.text()
    let envelope: { status?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; detail?: unknown } = {}
    if (text !== '') {
      try {
        envelope = JSON.parse(text) as typeof envelope
      } catch {
        // A non-JSON body (proxy error page): reported with the status below.
        envelope = { detail: text.slice(0, 200) }
      }
    }
    if (!response.ok || envelope.status === 'error' || envelope.error !== undefined && envelope.error !== null) {
      const code = typeof envelope.error?.code === 'string' ? envelope.error.code : undefined
      const message = typeof envelope.error?.message === 'string' ? envelope.error.message : String(envelope.detail ?? `HTTP ${response.status}`)
      throw new OpenVikingError(`OpenViking ${method} ${path}: ${message}`, response.status, code)
    }
    return envelope.result as T
  }
}
