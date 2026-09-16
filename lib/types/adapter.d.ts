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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { HuaweiTokenManager } from './token-manager.ts';
/** One optional model entry advertised by the adapter. */
export interface HuaweiCatalogModel {
    /** Wire model id accepted by the configured endpoint. */
    id: string;
    /** Selector label; defaults to {@link id}. */
    name?: string;
    /** Optional selector detail. */
    description?: string;
    /** Known combined request/response context capacity. */
    contextWindow?: number;
    /** Per-request output cap for this model. */
    maxTokens?: number;
}
/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` produces this shape; the adapter re-reads it per
 * operation.
 */
export interface HuaweiConnectionOptions {
    /** Full upstream endpoint URL (including path). */
    baseURL: string;
    /** Advisory models exposed to discovery consumers. */
    models: readonly HuaweiCatalogModel[];
    /** Maximum provider idle time while one stream read is outstanding. */
    streamIdleTimeoutMs: number;
    /** Provider-owned model-request retry policy. */
    retryPolicy: ResolvedRetryPolicy;
}
/** Constructor options for {@link HuaweiCodeAgentAdapter}. */
export interface HuaweiAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => HuaweiConnectionOptions;
    /** Token manager that handles login and caching. */
    tokenManager: HuaweiTokenManager;
}
/** Default maximum idle interval while an adapter stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Default combined request/response context capacity. */
export declare const DEFAULT_CONTEXT_WINDOW = 128000;
/** Default per-request output-token cap. */
export declare const DEFAULT_MAX_TOKENS = 8192;
/**
 * The `LlmAdapter` for the Huawei CodeAgent/CodeMate upstream. One instance
 * serves every model name it was registered under (the harness model name IS
 * the wire model name).
 */
export declare class HuaweiCodeAgentAdapter extends LlmAdapter {
    private readonly config;
    constructor(config: HuaweiAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * Execute the upstream request and translate the SSE stream. On a 401
     * (token expired server-side before the 24h cache), force-refresh the
     * token and retry exactly once.
     */
    private request;
}
//# sourceMappingURL=adapter.d.ts.map