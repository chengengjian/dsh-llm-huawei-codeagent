
import { readFileSync, appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest, ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  HuaweiCodeAgentAdapter,
} from './adapter.ts'
import type { HuaweiCatalogModel, HuaweiConnectionOptions } from './adapter.ts'
import { HuaweiTokenManager } from './token-manager.ts'

export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  HuaweiCodeAgentAdapter,
} from './adapter.ts'
export type { HuaweiAdapterOptions, HuaweiCatalogModel, HuaweiConnectionOptions } from './adapter.ts'
export { HuaweiTokenManager } from './token-manager.ts'
export type { TokenData, CredentialResolver } from './token-manager.ts'
export type * from './types.ts'

export const name = 'llm-huawei-codeagent'
export const inject = ['llm']

const NS = 'llm-huawei-codeagent'
const DEFAULT_API_KEY_ENV = 'HUAWEI_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'huawei-codeagent'

/** Default models advertised by the adapter (from the CodeAgent catalog). */
const DEFAULT_MODELS: HuaweiCatalogModel[] = [
  { id: 'maas-glm-5.2-zhipu', name: 'GLM 5.2 (Zhipu)', contextWindow: 128_000 },
  { id: 'maas-glm-5.2-aliyun', name: 'GLM 5.2 (Aliyun)', contextWindow: 128_000 },
  { id: 'maas-glm-5.2-volcengine-codeagent', name: 'GLM 5.2 (Volcengine)', contextWindow: 128_000 },
  { id: 'maas-qwen3.7-max', name: 'Qwen 3.7 Max', contextWindow: 128_000 },
  { id: 'maas-qwen3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 128_000 },
  { id: 'maas-glm-5.1-zhipu', name: 'GLM 5.1 (Zhipu)', contextWindow: 128_000 },
  { id: 'maas-MiniMax-M3', name: 'MiniMax M3', contextWindow: 128_000 },
  { id: 'GLM-5.1-CodeAgent', name: 'GLM 5.1 CodeAgent', contextWindow: 128_000 },
  { id: 'maas-glm-5-aliyun-codeagent', name: 'GLM 5 (Aliyun CodeAgent)', contextWindow: 128_000 },
  { id: 'Qwen3.6-27B-VL', name: 'Qwen 3.6 27B VL', contextWindow: 128_000 },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 128_000 },
]

const MODEL_MODALITIES = ['text'] as const satisfies readonly ModelModality[]

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
  apiKeyEnv?: string
  /**
   * Huawei internal service to route to. `codeagent` uses the CIDA snapengine
   * endpoint; `codemate` uses the CodeMate snapengine endpoint.
   */
  service?: 'codeagent' | 'codemate'
  /** Network zone: `green` (default) or `yellow`. */
  zone?: 'green' | 'yellow'
  /** Full upstream endpoint URL; overrides the zone/service default when set. */
  baseURL?: string
  /** Advisory models shown by discovery consumers; defaults to the CodeAgent catalog. */
  models?: HuaweiCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<HuaweiCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  service: z.union(['codeagent', 'codemate']).default('codeagent'),
  zone: z.union(['green', 'yellow']).default('green'),
  baseURL: z.string(),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/**
 * Default upstream endpoint URL for a service/zone combination. The green zone
 * is the default; yellow is the alternate network zone.
 */
function defaultBaseURL(service: 'codeagent' | 'codemate', zone: 'green' | 'yellow'): string {
  const zoneCode = zone === 'yellow' ? 'y' : 'g'
  if (service === 'codemate') {
    return `https://snapengine.codemate.cce.prod-kwe-${zoneCode}.dragon.tools.huawei.com/api/v2/chat/completions`
  }
  return `https://snapengine.cida.cce.prod-szv-${zoneCode}.dragon.tools.huawei.com/api/v2/chat/completions`
}

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly HuaweiCatalogModel[] | undefined): HuaweiCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-huawei-codeagent: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-huawei-codeagent: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-huawei-codeagent: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-huawei-codeagent: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-huawei-codeagent: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

/** Resolved connection facts for one operation. */
export type ResolvedHuaweiOptions = HuaweiConnectionOptions

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config: Config): ResolvedHuaweiOptions {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-huawei-codeagent: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const service = config.service ?? 'codeagent'
  const zone = config.zone ?? 'green'
  return {
    baseURL: config.baseURL ?? defaultBaseURL(service, zone),
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-huawei-codeagent: retryPolicy'),
  }
}

/**
 * Build a credential resolver that reads the `工号:密码` value from the
 * credential seam (or the environment as a fallback) and splits on the
 * first colon to obtain the user id and password. The resolver is per-call
 * so a changed password reaches the next login.
 */
function createCredentialResolver(
  ctx: Context,
  apiKeyRef: CredentialRef,
): () => Promise<{ userId: string; userPwd: string }> {
  return async () => {
    let raw: string | undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(apiKeyRef)
      if (hit !== undefined) raw = hit.value
    } else {
      const env = launchEnvironmentOf(ctx)
      const entry = env.get(apiKeyRef)
      if (entry !== undefined && entry.value.length > 0) raw = entry.value
    }
    if (raw === undefined || raw.length === 0) {
      throw new LlmError(
        'llm-huawei-codeagent: 凭证未配置，请在 Models 页面的 API Key 字段输入 "工号:密码"（例如 x12345678:YourPassword），'
        + `或导出环境变量 ${apiKeyRef}`,
        'MISSING_CREDENTIAL',
      )
    }
    const colonIdx = raw.indexOf(':')
    if (colonIdx <= 0) {
      throw new LlmError(
        'llm-huawei-codeagent: 凭证格式错误，需要在 API Key 中输入 "工号:密码"（冒号分隔），当前值缺少冒号',
        'MISSING_CREDENTIAL',
      )
    }
    return { userId: raw.slice(0, colonIdx), userPwd: raw.slice(colonIdx + 1) }
  }
}

/**
 * Huawei internal domain → IP mapping for DNS bypass. The container cannot
 * resolve these domains through its DNS resolver; appending them to
 * `/etc/hosts` lets `fetch()` connect by hostname while TLS SNI still uses
 * the real domain (because fetch resolves the hostname → /etc/hosts → IP,
 * but the TLS layer reads the original hostname for SNI).
 */
const DNS_BYPASS: ReadonlyArray<readonly [ip: string, hostname: string]> = [
  ['7.222.196.152', 'rnd-idea-api.huawei.com'],
  ['7.215.72.115', 'snapengine.cida.cce.prod-szv-g.dragon.tools.huawei.com'],
  ['7.215.72.115', 'snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com'],
  ['7.215.72.115', 'snapengine.codemate.cce.prod-kwe-g.dragon.tools.huawei.com'],
  ['7.215.72.115', 'snapengine.codemate.cce.prod-kwe-y.dragon.tools.huawei.com'],
]

/**
 * Append Huawei internal domains to `/etc/hosts` so `fetch()` can resolve
 * them. Idempotent: lines already present are skipped. The platform's
 * container runtime may not use the Docker ENTRYPOINT (K8s overrides it
 * with its own command), so this runs from `apply()` rather than an
 * entrypoint script. Also sets `NODE_TLS_REJECT_UNAUTHORIZED=0` because
 * the Huawei internal endpoints use self-signed certificates.
 */
function ensureNetworkBypass(): void {
  try {
    const hosts = readFileSync('/etc/hosts', 'utf-8')
    const missing = DNS_BYPASS.filter(([, hostname]) =>
      !new RegExp(`\\s${hostname.replace(/\./g, '\\.')}\\b`).test(hosts),
    )
    if (missing.length > 0) {
      appendFileSync('/etc/hosts', '\n' + missing.map(([ip, hostname]) => `${ip} ${hostname}`).join('\n') + '\n')
    }
  } catch {
    // Read-only /etc/hosts (e.g. ConfigMap mount) — the domains may already
    // be present or the platform has its own DNS solution; nothing to do.
  }
  // The env var must be set before the first TLS handshake. Setting it here
  // covers the case where the ENTRYPOINT was bypassed.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }
}

/**
 * Answer the Models page "Fetch available models" action. The adapter
 * already knows its catalog, so this returns the configured model list
 * directly — no network call needed. A route the adapter ships (provider
 * !== undefined) is answered from the catalog; a draft being composed
 * (provider === undefined) gets the full default catalog so the user can
 * adopt from it.
 */
function discoverModels(
  _request: LlmModelDiscoveryRequest,
  models: () => readonly HuaweiCatalogModel[],
): Promise<readonly LlmDiscoveredModel[]> {
  // A route the adapter already describes answers from that knowledge.
  const catalog = models()
  return Promise.resolve(catalog.map(model => ({
    id: model.id,
    ...model.name === undefined ? {} : { name: model.name },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
  } satisfies LlmDiscoveredModel)))
}

export function apply(ctx: Context, config: Config): void {
  // Ensure Huawei internal domains resolve and TLS bypass is active before
  // any request fires. Safe to call multiple times (idempotent).
  ensureNetworkBypass()

  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedHuaweiOptions | undefined
  const options = (): ResolvedHuaweiOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-huawei-codeagent: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  // Build the token manager with a credential resolver that re-reads the
  // current settings snapshot's credential reference per login.
  const resolveCredentials = createCredentialResolver(
    ctx,
    credentialRef(current().apiKeyEnv ?? DEFAULT_API_KEY_ENV),
  )
  const tokenManager = new HuaweiTokenManager(resolveCredentials)

  const adapter = new HuaweiCodeAgentAdapter({
    options,
    tokenManager,
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Huawei CodeAgent', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerModelDiscovery(NS, request =>
    discoverModels(request, () => options().models),
  )
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: ensureRegistrationFacts,
    })
  })
}
