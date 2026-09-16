
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest, ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  HuaweiCodeAgentAdapter,
} from './adapter.ts'
import type { HuaweiCatalogModel, HuaweiConnectionOptions } from './adapter.ts'
import { HuaweiModelCatalog } from './model-catalog.ts'
import { HuaweiTokenManager } from './token-manager.ts'

export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  HuaweiCodeAgentAdapter,
} from './adapter.ts'
export type { HuaweiAdapterOptions, HuaweiCatalogModel, HuaweiConnectionOptions } from './adapter.ts'
export { HuaweiTokenManager } from './token-manager.ts'
export type { TokenData, CredentialResolver } from './token-manager.ts'
export { parseModelCatalog } from './model-catalog.ts'
export type * from './types.ts'

export const name = 'llm-huawei-codeagent'
export const inject = ['llm']

const NS = 'llm-huawei-codeagent'
const DEFAULT_PASSWORD_ENV = 'HUAWEI_CODEAGENT_PASSWORD'
const DEFAULT_MODEL_CATALOG_URL = 'https://codeagentcli.rnd.huawei.com/codeAgentPro/chat/modles'
/** The single provider route this plugin owns. */
const PROVIDER = 'huawei-codeagent'

/** Default models advertised by the adapter (from the CodeAgent catalog). */
const DEFAULT_MODELS: HuaweiCatalogModel[] = [
  { id: 'maas-glm-5.2-zhipu', name: 'GLM 5.2 (Zhipu)' },
  { id: 'maas-glm-5.2-aliyun', name: 'GLM 5.2 (Aliyun)' },
  { id: 'maas-glm-5.2-volcengine-codeagent', name: 'GLM 5.2 (Volcengine)' },
  { id: 'maas-qwen3.7-max', name: 'Qwen 3.7 Max' },
  { id: 'maas-qwen3.7-plus', name: 'Qwen 3.7 Plus' },
  { id: 'maas-glm-5.1-zhipu', name: 'GLM 5.1 (Zhipu)' },
  { id: 'maas-MiniMax-M3', name: 'MiniMax M3' },
  { id: 'GLM-5.1-CodeAgent', name: 'GLM 5.1 CodeAgent' },
  { id: 'maas-glm-5-aliyun-codeagent', name: 'GLM 5 (Aliyun CodeAgent)' },
  { id: 'Qwen3.6-27B-VL', name: 'Qwen 3.6 27B VL' },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
]

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-huawei-codeagent` settings-section shape. Every field is
 * optional in yml: missing credentials resolve to `MISSING_CREDENTIAL` at
 * request time (not at plugin load).
 */
export interface Config {
  /** Huawei domain account/work number. This is configuration, not a secret. */
  userId?: string
  /** Credential reference holding only the Huawei domain password. */
  passwordEnv?: string
  /**
   * Huawei internal service to route to. `codeagent` uses the CIDA snapengine
   * endpoint; `codemate` uses the CodeMate snapengine endpoint.
   */
  service?: 'codeagent' | 'codemate'
  /** Network zone: `green` (default) or `yellow`. */
  zone?: 'green' | 'yellow'
  /** Full upstream endpoint URL; overrides the zone/service default when set. */
  baseURL?: string
  /** CodeAgent CLI model-directory endpoint. */
  modelCatalogURL?: string
  /** Ask the directory to return only models available to the current account. */
  filterModelsByPermission?: boolean
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
  maxInputTokens: z.number().step(1).min(1),
  // The settings editor serializes an untouched optional multi-select as an
  // empty array. Treat that as "not configured" so catalog discovery can
  // still supply the upstream modalities.
  inputModalities: z.array(z.union(MODEL_MODALITIES)),
})

export const Config: z<Config> = z.object({
  userId: z.string(),
  passwordEnv: z.string().role('credential-ref').default(DEFAULT_PASSWORD_ENV),
  service: z.union(['codeagent', 'codemate']).default('codeagent'),
  zone: z.union(['green', 'yellow']).default('green'),
  baseURL: z.string(),
  modelCatalogURL: z.string().default(DEFAULT_MODEL_CATALOG_URL),
  filterModelsByPermission: z.boolean().default(false),
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
    if (model.maxInputTokens !== undefined
      && (!Number.isInteger(model.maxInputTokens) || model.maxInputTokens <= 0)) {
      throw new Error(
        `llm-huawei-codeagent: catalog model "${model.id}" maxInputTokens must be a positive integer`,
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
      ...model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens },
      ...model.inputModalities === undefined || model.inputModalities.length === 0
        ? {}
        : { inputModalities: [...model.inputModalities] },
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
    service,
    zone,
    baseURL: config.baseURL ?? defaultBaseURL(service, zone),
    modelCatalogURL: config.modelCatalogURL ?? DEFAULT_MODEL_CATALOG_URL,
    filterModelsByPermission: config.filterModelsByPermission ?? false,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-huawei-codeagent: retryPolicy'),
  }
}

/**
 * Build a credential resolver that reads the account from settings and the
 * password from the credential seam (or the environment as a fallback).
 * The resolver is per-call so edited settings and rotated passwords reach the
 * next login without restarting DSH.
 */
function createCredentialResolver(
  ctx: Context,
  config: () => Config,
): () => Promise<{ userId: string; userPwd: string }> {
  return async () => {
    const current = config()
    const userId = current.userId?.trim() ?? ''
    const passwordRef = credentialRef(current.passwordEnv ?? DEFAULT_PASSWORD_ENV)
    if (userId.length === 0) {
      throw new LlmError(
        'llm-huawei-codeagent: 工号未配置，请在 Models 页面填写华为工号',
        'MISSING_CREDENTIAL',
      )
    }
    let userPwd: string | undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(passwordRef)
      if (hit !== undefined) userPwd = hit.value
    } else {
      const env = launchEnvironmentOf(ctx)
      const entry = env.get(passwordRef)
      if (entry !== undefined && entry.value.length > 0) userPwd = entry.value
    }
    if (userPwd === undefined || userPwd.length === 0) {
      throw new LlmError(
        `llm-huawei-codeagent: 密码未配置，请在 Models 页面填写密码，或导出环境变量 ${passwordRef}`,
        'MISSING_CREDENTIAL',
      )
    }
    return { userId, userPwd }
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
  const resolveCredentials = createCredentialResolver(ctx, current)
  const tokenManager = new HuaweiTokenManager(resolveCredentials)
  const modelCatalog = new HuaweiModelCatalog(options, tokenManager, (error) => {
    ctx.logger.warn(`llm-huawei-codeagent: model catalog unavailable, using static fallback: ${String(error)}`)
  })

  const adapter = new HuaweiCodeAgentAdapter({
    options,
    tokenManager,
    resolveCatalogModel: (model, signal) => modelCatalog.resolve(model, signal),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Huawei CodeAgent', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerModelDiscovery(NS, async (request) => {
    const models = await modelCatalog.list()
    return discoverModels(request, () => models)
  })
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
