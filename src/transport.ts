import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

const HUAWEI_DOMAIN = 'huawei.com'

// Keep insecure TLS scoped to this provider. The environment proxy dispatcher
// preserves the DSH auth-proxy -> smart-gateway route while disabling target
// certificate verification only for requests made through this module.
const dispatcher = new EnvHttpProxyAgent({
  requestTls: { rejectUnauthorized: false },
})

function assertHuaweiEndpoint(input: string | URL): void {
  const url = input instanceof URL ? input : new URL(input)
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:'
    || (hostname !== HUAWEI_DOMAIN && !hostname.endsWith(`.${HUAWEI_DOMAIN}`))
  ) {
    throw new TypeError(`Huawei transport refuses non-Huawei HTTPS endpoint: ${url.origin}`)
  }
}

/**
 * Fetch one Huawei endpoint through the process proxy without validating the
 * target certificate.
 *
 * @param input - An HTTPS URL under `huawei.com`.
 * @param init - Standard request options forwarded to Undici.
 * @returns The upstream response.
 */
export async function huaweiFetch(
  input: string | URL,
  init: Parameters<typeof undiciFetch>[1] = {},
): Promise<Response> {
  assertHuaweiEndpoint(input)
  return await undiciFetch(input, { ...init, dispatcher }) as unknown as Response
}
