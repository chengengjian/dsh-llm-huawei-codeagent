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
/**
 * A cached token with its department header value and expiry. The
 * department is URL-encoded because it travels in an HTTP header and may
 * contain non-ASCII characters.
 */
export interface TokenData {
    /** The authToken from `cloudDragonTokens.authToken`. */
    token: string;
    /** URL-encoded department path from userInfo (for the CodeMate `department` header). */
    department: string;
    /** Epoch milliseconds when this token expires. */
    expiry: number;
}
/**
 * Resolve credentials for one login attempt. Both values must be non-empty;
 * the adapter validates this before constructing the manager and again on
 * each refresh. The resolver is per-call so a changed password (stored through
 * the credentials seam) reaches the next login without a restart.
 */
export type CredentialResolver = () => Promise<{
    userId: string;
    userPwd: string;
}>;
/**
 * Token acquisition and cache manager for the Huawei CodeAgent/CodeMate
 * upstream. One instance per adapter; the adapter constructs it once and
 * reuses it for every request.
 */
export declare class HuaweiTokenManager {
    private readonly resolveCredentials;
    private cached;
    /** In-flight refresh promise; concurrent `getToken` callers share it. */
    private inflight;
    constructor(resolveCredentials: CredentialResolver);
    /**
     * Get a valid token, refreshing the cache when it is missing or expired.
     * Concurrent callers share one in-flight refresh to avoid duplicate
     * logins.
     * @param force - when true, ignore the cache and refresh unconditionally.
     * @returns the cached token data.
     * @throws `LlmError` with code `AUTH` when the login fails (credential
     * invalid or network error).
     */
    getToken(force?: boolean): Promise<TokenData>;
    /** Whether a cached token is present and has not expired. */
    private isValid;
    /**
     * Execute one login attempt and cache the result. Multiple concurrent
     * callers share the same in-flight promise so only one HTTP login fires.
     */
    private refresh;
    /**
     * Execute one login POST and parse the response.
     * @throws `LlmError` `AUTH` when the login succeeds but returns no
     * authToken (password invalid), `TRANSPORT` on a network/parse error.
     */
    private doLogin;
}
//# sourceMappingURL=token-manager.d.ts.map