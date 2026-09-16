import { LlmError } from '@deepseek-ai/dsh-llm'
import type { HuaweiCatalogModel, HuaweiConnectionOptions } from './adapter.ts'
import { huaweiFetch } from './transport.ts'
import type { HuaweiTokenManager, TokenData } from './token-manager.ts'

const CATALOG_CACHE_MS = 6 * 60 * 60 * 1000
const CATALOG_FAILURE_CACHE_MS = 5 * 60 * 1000
const CATALOG_TIMEOUT_MS = 15_000
const CODEAGENT_CLIENT_VERSION = 'cli-1.2605.03-IN.2'
const USER_DETAIL_URL = 'https://codeagentcli.rnd.huawei.com/codeAgentPro/auth/internal/getUserDetail'

type JsonObject = Record<string, unknown>

interface CodeAgentUserDetail {
  departmentPath?: string
  w3account?: string
  region?: string
}

function objectOf(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function numberAt(source: JsonObject, ...paths: readonly (readonly string[])[]): number | undefined {
  for (const path of paths) {
    let value: unknown = source
    for (const segment of path) value = objectOf(value)?.[segment]
    const parsed = positiveInteger(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function stringAt(source: JsonObject, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function modalityObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'string') return objectOf(value)
  try {
    return objectOf(JSON.parse(value))
  } catch {
    return undefined
  }
}

function inputModalitiesOf(source: JsonObject): HuaweiCatalogModel['inputModalities'] {
  const input = modalityObject(source.modalities)?.input
  if (!Array.isArray(input)) return undefined
  const modalities = input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
  return modalities.length === 0 ? undefined : [...new Set(modalities)]
}

function modelOf(value: unknown, fallbackId?: string): HuaweiCatalogModel | undefined {
  const source = objectOf(value)
  if (source === undefined) return undefined
  const id = stringAt(source, 'id', 'model', 'modelId', 'model_id') ?? fallbackId
  if (id === undefined || id.length === 0) return undefined
  const input = numberAt(source, ['input'], ['inputLength'], ['input_length'])
  const output = numberAt(source, ['output'], ['outputLength'], ['output_length'])
  const contextWindow = numberAt(
    source,
    ['context'],
    ['contextWindow'],
    ['context_window'],
    ['maxContextTokens'],
    ['max_context_tokens'],
    ['max_model_len'],
  )
  const maxTokens = numberAt(
    source,
    ['maxTokens'],
    ['max_tokens'],
    ['maxOutputTokens'],
    ['max_output_tokens'],
  ) ?? output
  const name = stringAt(source, 'name', 'displayName', 'modelName', 'model_name')
  const description = stringAt(source, 'des', 'description', 'modelDesc', 'model_desc')
  const inputModalities = inputModalitiesOf(source)
  return {
    id,
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...input === undefined ? {} : { maxInputTokens: input },
    ...inputModalities === undefined ? {} : { inputModalities },
  }
}

function modelEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const root = objectOf(value)
  if (root === undefined) return []
  for (const key of ['data', 'modelList', 'models', 'result']) {
    if (Array.isArray(root[key])) return root[key]
  }
  return []
}

/** Parse CodeAgent catalog records, including routed models nested under Auto entries. */
export function parseModelCatalog(payload: unknown): HuaweiCatalogModel[] {
  const parsed: HuaweiCatalogModel[] = []
  for (const entry of modelEntries(payload)) {
    const source = objectOf(entry)
    if (source === undefined) continue
    const routed = Array.isArray(source.routModels) ? source.routModels : []
    if (routed.length > 0) {
      for (const route of routed) {
        const routeSource = objectOf(route)
        const model = routeSource === undefined
          ? undefined
          : modelOf({ ...source, ...routeSource, routModels: undefined })
        if (model !== undefined) parsed.push(model)
      }
      continue
    }
    const model = modelOf(source)
    if (model !== undefined) parsed.push(model)
  }
  return [...new Map(parsed.map(model => [model.id, model])).values()]
}

function mergeModels(
  configured: readonly HuaweiCatalogModel[],
  discovered: readonly HuaweiCatalogModel[],
): HuaweiCatalogModel[] {
  const configuredById = new Map(configured.map(model => [model.id, model]))
  const merged = discovered.map(model => ({ ...model, ...configuredById.get(model.id) }))
  const discoveredIds = new Set(discovered.map(model => model.id))
  merged.push(...configured.filter(model => !discoveredIds.has(model.id)).map(model => ({ ...model })))
  return merged
}

function userDetailOf(payload: unknown): CodeAgentUserDetail {
  const root = objectOf(payload)
  const source = objectOf(root?.data) ?? objectOf(root?.result) ?? root
  if (source === undefined) return {}
  const departmentPath = stringAt(source, 'departmentPath', 'department_path')
  const w3account = stringAt(source, 'w3account', 'w3Account', 'account')
  const region = stringAt(source, 'region', 'area')
  return {
    ...departmentPath === undefined ? {} : { departmentPath },
    ...w3account === undefined ? {} : { w3account },
    ...region === undefined ? {} : { region },
  }
}

function userDetailHeaders(token: TokenData): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-auth-token': token.token,
    'Agent-Type': 'AgentCenter',
    'X-Language': 'en-us',
  }
}

function catalogHeaders(
  token: TokenData,
  detail: CodeAgentUserDetail,
  fallbackZone: 'green' | 'yellow',
): Record<string, string> {
  const region = detail.region?.toLowerCase()
  const area = region === 'y' || region === 'yellow' ? 'yellow'
    : region === 'g' || region === 'green' ? 'green' : fallbackZone
  return {
    'content-type': 'application/json',
    'User-Agent': 'axios/1.18.1',
    'x-auth-token': token.token,
    'agent-type': 'AgentCenter',
    area,
    'plugin-version': CODEAGENT_CLIENT_VERSION,
    'x-agent-client-version': CODEAGENT_CLIENT_VERSION,
    'x-language': 'en-us',
    ...detail.departmentPath === undefined ? {} : {
      depart: detail.departmentPath,
      'x-agent-user-department': detail.departmentPath,
    },
    ...detail.w3account === undefined ? {} : { 'x-agent-user-account': detail.w3account },
  }
}

interface CacheEntry {
  key: string
  expiresAt: number
  models: readonly HuaweiCatalogModel[]
}

/** Cached best-effort reader for the Huawei CodeAgent model directory. */
export class HuaweiModelCatalog {
  private cache: CacheEntry | undefined

  constructor(
    private readonly options: () => HuaweiConnectionOptions,
    private readonly tokenManager: HuaweiTokenManager,
    private readonly reportFailure: (error: unknown) => void = () => {},
  ) {}

  private async fetchCodeAgent(
    connection: HuaweiConnectionOptions,
    signal?: AbortSignal,
    forceToken = false,
  ): Promise<HuaweiCatalogModel[]> {
    const token = await this.tokenManager.getToken(forceToken)
    const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const detailResponse = await huaweiFetch(USER_DETAIL_URL, {
      method: 'POST',
      headers: userDetailHeaders(token),
      body: '{}',
      signal: requestSignal,
    })
    if (detailResponse.status === 401 && !forceToken) return this.fetchCodeAgent(connection, signal, true)
    let detail: CodeAgentUserDetail = {}
    if (detailResponse.ok) {
      try {
        detail = userDetailOf(await detailResponse.json())
      } catch {
        // The catalog can still answer a reduced list without user metadata.
      }
    }
    const url = new URL(connection.modelCatalogURL)
    url.searchParams.set('checkUserPermission', connection.filterModelsByPermission ? 'TRUE' : 'FALSE')
    const response = await huaweiFetch(url, {
      method: 'GET',
      headers: catalogHeaders(token, detail, connection.zone),
      signal: requestSignal,
    })
    if (response.status === 401 && !forceToken) return this.fetchCodeAgent(connection, signal, true)
    if (!response.ok) {
      throw new LlmError(`huawei-codeagent model catalog error (HTTP ${response.status})`, `HTTP_${response.status}`)
    }
    const discovered = parseModelCatalog(await response.json())
    if (discovered.length === 0) throw new Error('Huawei CodeAgent model catalog returned no readable models')
    return discovered
  }

  async list(signal?: AbortSignal): Promise<readonly HuaweiCatalogModel[]> {
    const connection = this.options()
    const key = JSON.stringify({
      service: connection.service,
      zone: connection.zone,
      url: connection.modelCatalogURL,
      filter: connection.filterModelsByPermission,
      models: connection.models,
    })
    if (this.cache?.key === key && Date.now() < this.cache.expiresAt) return this.cache.models
    if (connection.service !== 'codeagent') return connection.models.map(model => ({ ...model }))
    try {
      const discovered = await this.fetchCodeAgent(connection, signal)
      const models = mergeModels(connection.models, discovered)
      this.cache = { key, expiresAt: Date.now() + CATALOG_CACHE_MS, models }
      return models
    } catch (error) {
      if (signal?.aborted === true) throw error
      this.reportFailure(error)
      const models = connection.models.map(model => ({ ...model }))
      this.cache = { key, expiresAt: Date.now() + CATALOG_FAILURE_CACHE_MS, models }
      return models
    }
  }

  async resolve(model: string, signal?: AbortSignal): Promise<HuaweiCatalogModel | undefined> {
    return (await this.list(signal)).find(entry => entry.id === model)
  }
}
