/**
 * Decode an SSE byte stream into event `data` payloads. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment and non-data field skipping,
 * multi-`data:` joining — is `eventsource-parser`'s. Comments are reported
 * only through an optional transport-activity callback. This module keeps the
 * same protocol as the DeepSeek adapter: the literal `[DONE]` is yielded so
 * the caller owns final flushing, and EOF before it raises `LlmError`.
 *
 * The Huawei CodeAgent upstream sends standard SSE (`data: {json}\n\n`),
 * so `eventsource-parser`'s spec-strict framing applies directly.
 *
 * @module dsh-llm-huawei-codeagent/sse
 */
/** The terminal payload the upstream sends after the last chunk. */
export declare const DONE = "[DONE]";
/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export declare function parseSse(stream: ReadableStream<BufferSource>, onComment?: (comment: string) => void): AsyncGenerator<string>;
//# sourceMappingURL=sse.d.ts.map