/**
 * `HuaweiCodeAgentAdapter`: fetch + SSE against a Huawei CodeAgent/CodeMate
 * chat-completions endpoint, emitting harness StreamChunks.
 *
 * The adapter is transport-only: connection facts arrive through a thunk
 * resolved once per operation and the auth token through a per-request
 * resolver (the `HuaweiTokenManager`), so the registering plugin owns
 * validation, layering, and credential policy.
 *
 * The upstream speaks standard OpenAI Chat Completions, so request
 * serialization, SSE parsing, and chunk translation follow the same pattern
 * as the DeepSeek adapter. The differences are:
 *
 * - Authentication: instead of a `Bearer` API key, the adapter logs into
 *   `rnd-idea-api.huawei.com` with a domain account to obtain an
 *   `authToken`, injected as the `x-auth-token` header.
 * - Business headers: the upstream requires several CodeAgent-specific
 *   headers (`app-id`, `User-Agent: codeagent`, `plugin-version`, etc.).
 * - TLS: Huawei requests use a provider-scoped proxy dispatcher that accepts
 *   the internal certificate chain without changing process-wide TLS policy.
 *
 * @module dsh-llm-huawei-codeagent/adapter
 */

import {
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import { huaweiFetch } from './transport.ts'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { HuaweiTokenManager, TokenData } from './token-manager.ts'
import { serializeRequest } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** One optional model entry advertised by the adapter. */
export interface HuaweiCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Provider-reported maximum input tokens, retained as catalog metadata. */
  maxInputTokens?: number
  /** Input modalities accepted by this model. */
  inputModalities?: ModelModality[]
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` produces this shape; the adapter re-reads it per
 * operation.
 */
export interface HuaweiConnectionOptions {
  /** Huawei upstream family whose directory protocol should be used. */
  service: 'codeagent' | 'codemate'
  /** Network zone used when account metadata does not report one. */
  zone: 'green' | 'yellow'
  /** Full upstream endpoint URL (including path). */
  baseURL: string
  /** CodeAgent model-directory endpoint. */
  modelCatalogURL: string
  /** Whether the directory should filter the catalog by current-account permission. */
  filterModelsByPermission: boolean
  /** Advisory models exposed to discovery consumers. */
  models: readonly HuaweiCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link HuaweiCodeAgentAdapter}. */
export interface HuaweiAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => HuaweiConnectionOptions
  /** Token manager that handles login and caching. */
  tokenManager: HuaweiTokenManager
  /** Resolve live provider metadata for one model, with configured fallback. */
  resolveCatalogModel?: (model: string, signal?: AbortSignal) => Promise<HuaweiCatalogModel | undefined>
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 128_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 8_192

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function modelInfo(provider: string, model: HuaweiCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (detail.length > 0 && /context.*(length|window|exceed)/i.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Build the CodeAgent-specific headers for one upstream request.
 *
 * These headers are aligned with the CodeAgent CLI and are required for the
 * upstream routing layer to accept the request. The `x-auth-token` is the
 * authToken from the Huawei IDEA secureLogin.
 */
export function buildUpstreamHeaders(
  tokenData: TokenData,
  accept = 'text/event-stream',
): Record<string, string> {
  return {
    // ── Authentication ──
    'User-Agent': 'codeagent',
    'x-auth-token': tokenData.token,
    'authorization': 'Bearer',

    // ── CodeAgent CLI-aligned headers ──
    'app-id': 'com.huawei.devmind.codebot.apibot',
    'plugin-version': 'cli-1.2605.03-IN.2',
    'x-codeagent-request-kind': 'main_conversation',
    'x-error-propagation': 'true',

    // ── Content headers ──
    'content-type': 'application/json',
    'accept': accept,
  }
}

/**
 * The `LlmAdapter` for the Huawei CodeAgent/CodeMate upstream. One instance
 * serves every model name it was registered under (the harness model name IS
 * the wire model name).
 */
export class HuaweiCodeAgentAdapter extends LlmAdapter {
  constructor(private readonly config: HuaweiAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Huawei CodeAgent' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = await this.config.resolveCatalogModel?.(model, signal)
      ?? connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? DEFAULT_MAX_TOKENS,
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const tokenManager = this.config.tokenManager

    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request.
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)

    // Get the auth token (cached, auto-refreshed on expiry).
    let tokenData: TokenData
    try {
      tokenData = await tokenManager.getToken()
    } catch (error: unknown) {
      if (error instanceof LlmError) throw error
      throw new LlmError(
        'huawei-codeagent: failed to acquire auth token',
        'TRANSPORT',
        { cause: error },
      )
    }

    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      tokenManager,
      tokenData,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `huawei-codeagent stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('huawei-codeagent request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `huawei-codeagent API stream from ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    } finally {
      consumer.abort('huawei-codeagent stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  /**
   * Execute the upstream request and translate the SSE stream. On a 401
   * (token expired server-side before the 24h cache), force-refresh the
   * token and retry exactly once.
   */
  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: HuaweiConnectionOptions,
    tokenManager: HuaweiTokenManager,
    tokenData: TokenData,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options)
    const payload = JSON.stringify(body)

    let headers = buildUpstreamHeaders(tokenData)

    let response: Response
    try {
      response = await huaweiFetch(connection.baseURL, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `huawei-codeagent API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    // On 401, the cached token may have been invalidated server-side before
    // its 24h expiry. Force-refresh and retry exactly once.
    if (response.status === 401) {
      try {
        tokenData = await tokenManager.getToken(true)
      } catch (error: unknown) {
        if (error instanceof LlmError) throw error
        throw new LlmError(
          'huawei-codeagent: token refresh after 401 failed',
          'AUTH',
          { cause: error },
        )
      }
      headers = buildUpstreamHeaders(tokenData)
      try {
        response = await huaweiFetch(connection.baseURL, {
          method: 'POST',
          headers,
          body: payload,
          signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new LlmError(
          `huawei-codeagent API retry request to ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    if (!response.ok) {
      let message = `huawei-codeagent API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing.
      }
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
      })
    }

    if (!response.body) {
      throw new LlmError('huawei-codeagent API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }
}
