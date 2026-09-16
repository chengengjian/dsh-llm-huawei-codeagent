/**
 * HuaweiTokenManager — TypeScript port of the Python `TokenManager`.
 *
 * Logs into `rnd-idea-api.huawei.com` with a Huawei domain account (工号 +
 * password) to obtain a `cloudDragonTokens.authToken`, caches it for 24 hours,
 * and refreshes on demand (forced or on expiry).
 *
 * The credential arrives as a single `工号:密码` string through the
 * {@link CredentialResolver}; the split on the first colon happens in the
 * resolver, not here, so the manager sees already-separated values.
 *
 * The token is injected as the `x-auth-token` header on every upstream
 * CodeAgent/CodeMate request. The department string (built from userInfo
 * fields) is also cached for the CodeMate `department` header.
 *
 * @module dsh-llm-huawei-codeagent/token-manager
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { WireLoginResponse } from './types.ts'

/** Login API endpoint for Huawei IDEA secureLogin. */
const TOKEN_REFRESH_URL = 'https://rnd-idea-api.huawei.com/ideaclientservice/login/v4/secureLogin'

/** Token cache duration in milliseconds (24 hours). */
const TOKEN_CACHE_DURATION_MS = 24 * 60 * 60 * 1000

/**
 * A cached token with its department header value and expiry. The
 * department is URL-encoded because it travels in an HTTP header and may
 * contain non-ASCII characters.
 */
export interface TokenData {
  /** The authToken from `cloudDragonTokens.authToken`. */
  token: string
  /** URL-encoded department path from userInfo (for the CodeMate `department` header). */
  department: string
  /** Epoch milliseconds when this token expires. */
  expiry: number
}

/**
 * Resolve credentials for one login attempt. Both values must be non-empty;
 * the adapter validates this before constructing the manager and again on
 * each refresh. The resolver is per-call so a changed password (stored through
 * the credentials seam) reaches the next login without a restart.
 */
export type CredentialResolver = () => Promise<{ userId: string; userPwd: string }>

/** One open refresh promise; concurrent callers share it to avoid duplicate logins. */
type RefreshResult = { ok: true; data: TokenData } | { ok: false; error: Error }

/**
 * Token acquisition and cache manager for the Huawei CodeAgent/CodeMate
 * upstream. One instance per adapter; the adapter constructs it once and
 * reuses it for every request.
 */
export class HuaweiTokenManager {
  private cached: TokenData | undefined
  /** In-flight refresh promise; concurrent `getToken` callers share it. */
  private inflight: Promise<RefreshResult> | undefined

  constructor(private readonly resolveCredentials: CredentialResolver) {}

  /**
   * Get a valid token, refreshing the cache when it is missing or expired.
   * Concurrent callers share one in-flight refresh to avoid duplicate
   * logins.
   * @param force - when true, ignore the cache and refresh unconditionally.
   * @returns the cached token data.
   * @throws `LlmError` with code `AUTH` when the login fails (credential
   * invalid or network error).
   */
  async getToken(force = false): Promise<TokenData> {
    const cached = this.cached
    if (!force && this.isValid(cached)) {
      return cached
    }
    const result = await this.refresh()
    if (!result.ok) {
      throw result.error
    }
    return result.data
  }

  /** Whether a cached token is present and has not expired. */
  private isValid(data: TokenData | undefined): data is TokenData {
    return data !== undefined && data.token.length > 0 && Date.now() < data.expiry
  }

  /**
   * Execute one login attempt and cache the result. Multiple concurrent
   * callers share the same in-flight promise so only one HTTP login fires.
   */
  private async refresh(): Promise<RefreshResult> {
    if (this.inflight !== undefined) {
      return this.inflight
    }
    this.inflight = (async () => {
      try {
        const { userId, userPwd } = await this.resolveCredentials()
        if (userId.length === 0 || userPwd.length === 0) {
          return {
            ok: false,
            error: new LlmError(
              'huawei-codeagent: 工号或密码未配置，请在 Models 页面的 API Key 字段输入 "工号:密码"',
              'MISSING_CREDENTIAL',
            ),
          }
        }
        const data = await this.doLogin(userId, userPwd)
        this.cached = data
        return { ok: true, data }
      } catch (error: unknown) {
        if (error instanceof LlmError) {
          return { ok: false, error }
        }
        return {
          ok: false,
          error: new LlmError(
            `huawei-codeagent: 登录请求异常（网络/代理错误），请检查内网连通性: ${String(error)}`,
            'TRANSPORT',
            { cause: error },
          ),
        }
      } finally {
        this.inflight = undefined
      }
    })()
    return this.inflight
  }

  /**
   * Execute one login POST and parse the response.
   * @throws `LlmError` `AUTH` when the login succeeds but returns no
   * authToken (password invalid), `TRANSPORT` on a network/parse error.
   */
  private async doLogin(userId: string, userPwd: string): Promise<TokenData> {
    let response: Response
    try {
      response = await fetch(TOKEN_REFRESH_URL, {
        method: 'POST',
        headers: {
          'X-Language': 'en',
          'Content-Type': 'application/json; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
          'X-User-Id': userId,
        },
        body: JSON.stringify({
          user: userId,
          password: userPwd,
          requireUserInfo: true,
          appName: 'vscodehuawei',
          oauthApp: 'vscodehuawei',
          requireCodeHubOpenToken: true,
        }),
      })
    } catch (error: unknown) {
      throw new LlmError(
        `huawei-codeagent: 登录请求失败（网络错误）: ${String(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }

    let body: WireLoginResponse
    try {
      body = await response.json() as WireLoginResponse
    } catch (error: unknown) {
      throw new LlmError(
        `huawei-codeagent: 登录响应解析失败 (HTTP ${response.status})`,
        'TRANSPORT',
        { cause: error },
      )
    }

    const token = body.cloudDragonTokens?.authToken
    if (token === undefined || token.length === 0) {
      throw new LlmError(
        'huawei-codeagent: 域账号密码可能已失效，请在 Models 页面更新 API Key 中的 "工号:密码"',
        'AUTH',
      )
    }

    const u = body.userInfo ?? {}
    const department = encodeURIComponent(
      [u.hwDepartName1 ?? '', u.hwDepartName2 ?? '', u.hwDepartName3 ?? '',
        u.hwDepartName4 ?? '', u.hwDepartName5 ?? '', u.hwDepartName6 ?? ''].join('/'),
    )

    return {
      token,
      department,
      expiry: Date.now() + TOKEN_CACHE_DURATION_MS,
    }
  }
}
