import { fetch as undiciFetch } from 'undici';
/**
 * Fetch one Huawei endpoint through the process proxy without validating the
 * target certificate.
 *
 * @param input - An HTTPS URL under `huawei.com`.
 * @param init - Standard request options forwarded to Undici.
 * @returns The upstream response.
 */
export declare function huaweiFetch(input: string | URL, init?: Parameters<typeof undiciFetch>[1]): Promise<Response>;
//# sourceMappingURL=transport.d.ts.map