import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { HuaweiCatalogModel, HuaweiConnectionOptions } from './adapter.ts';
export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, HuaweiCodeAgentAdapter, } from './adapter.ts';
export type { HuaweiAdapterOptions, HuaweiCatalogModel, HuaweiConnectionOptions } from './adapter.ts';
export { HuaweiTokenManager } from './token-manager.ts';
export type { TokenData, CredentialResolver } from './token-manager.ts';
export type * from './types.ts';
export declare const name = "llm-huawei-codeagent";
export declare const inject: string[];
/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-huawei-codeagent` settings-section shape. Every field is
 * optional in yml: missing credentials resolve to `MISSING_CREDENTIAL` at
 * request time (not at plugin load).
 */
export interface Config {
    /**
     * Credential reference (environment-variable name) holding the
     * `工号:密码` value; defaults to `HUAWEI_API_KEY`. The Models page
     * derives this from `apiKeyEnv` and writes through `credentials.set`.
     */
    apiKeyEnv?: string;
    /**
     * Huawei internal service to route to. `codeagent` uses the CIDA snapengine
     * endpoint; `codemate` uses the CodeMate snapengine endpoint.
     */
    service?: 'codeagent' | 'codemate';
    /** Network zone: `green` (default) or `yellow`. */
    zone?: 'green' | 'yellow';
    /** Full upstream endpoint URL; overrides the zone/service default when set. */
    baseURL?: string;
    /** Advisory models shown by discovery consumers; defaults to the CodeAgent catalog. */
    models?: HuaweiCatalogModel[];
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const Config: z<Config>;
/** Resolved connection facts for one operation. */
export type ResolvedHuaweiOptions = HuaweiConnectionOptions;
/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
export declare function resolveAdapterOptions(config: Config): ResolvedHuaweiOptions;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map