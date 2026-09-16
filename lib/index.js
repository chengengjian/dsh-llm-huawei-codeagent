import z from "@deepseek-ai/schemastery";
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, RetryPolicySchema, ToolCallId, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { EnvHttpProxyAgent, fetch } from "undici";
import { EventSourceParserStream } from "eventsource-parser/stream";
//#region src/transport.ts
const HUAWEI_DOMAIN = "huawei.com";
const dispatcher = new EnvHttpProxyAgent({ requestTls: { rejectUnauthorized: false } });
function assertHuaweiEndpoint(input) {
	const url = input instanceof URL ? input : new URL(input);
	const hostname = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || hostname !== HUAWEI_DOMAIN && !hostname.endsWith(`.${HUAWEI_DOMAIN}`)) throw new TypeError(`Huawei transport refuses non-Huawei HTTPS endpoint: ${url.origin}`);
}
/**
* Fetch one Huawei endpoint through the process proxy without validating the
* target certificate.
*
* @param input - An HTTPS URL under `huawei.com`.
* @param init - Standard request options forwarded to Undici.
* @returns The upstream response.
*/
async function huaweiFetch(input, init = {}) {
	assertHuaweiEndpoint(input);
	return await fetch(input, {
		...init,
		dispatcher
	});
}
//#endregion
//#region src/serialize.ts
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
	const text = flattenText(message.content);
	const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	return {
		role: "assistant",
		content: text,
		...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
}
/**
* Serialize the conversation. `tool-result` blocks become standalone
* `{role: 'tool'}` messages.
* @param messages - the harness conversation, in order.
* @returns the wire messages; order preserved, each tool result expanded into its own entry.
*/
function serializeMessages(messages) {
	const wire = [];
	for (const message of messages) {
		if (message.role === "system") {
			wire.push({
				role: "system",
				content: flattenText(message.content)
			});
			continue;
		}
		if (message.role === "assistant") {
			wire.push(serializeAssistant(message));
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (text.length > 0 || toolResults.length === 0) wire.push({
			role: "user",
			content: text
		});
		for (const result of toolResults) wire.push({
			role: "tool",
			tool_call_id: result.toolCallId,
			content: flattenText(result.content) || "(no output)"
		});
	}
	return wire;
}
/**
* Build the full wire request. Always streaming (`stream: true`, usage
* reporting on); optional fields are omitted rather than sent as null, so
* provider defaults apply.
* @param options - the harness request (model, history, system, tools, sampling).
* @returns the chat-completions request body.
*/
function serializeRequest(options) {
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: options.system
	});
	messages.push(...serializeMessages(options.messages));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	return {
		model: options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...options.stop !== void 0 ? { stop: options.stop } : {}
	};
}
/**
* Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
* value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
* without it (truncated response — the model call cannot be trusted).
* @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
* @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
*/
async function* parseSse(stream, onComment) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
	for await (const { data } of events) {
		yield data;
		if (data === "[DONE]") return;
	}
	throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region src/translate.ts
/**
* Translate Huawei CodeAgent SSE payloads with one stateful harness block per
* content, reasoning, or tool-call index. An empty initial reasoning delta
* does not open a block. Finish reason and the latest usage are deferred until
* `[DONE]`, covering both finish-attached and trailing usage-only shapes while
* ensuring no chunk follows `finish`.
*
* This is the same translation logic as the DeepSeek adapter's, since both
* upstreams speak OpenAI Chat Completions streaming format.
*
* @module dsh-llm-huawei-codeagent/translate
*/
/**
* Map the wire `finish_reason` vocabulary to the harness `FinishReason`.
* @param reason - the wire `finish_reason` string.
* @returns the mapped reason; unrecognized values become `{kind: 'error'}`.
*/
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/**
* Map wire usage fields. Cache reads are subtracted from input tokens to keep
* the harness convention of disjoint counts.
* @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
* @returns disjoint harness counts.
*/
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
* Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
* @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
* @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
*/
async function* translate(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			if (pendingUsage) yield {
				type: "usage",
				usage: pendingUsage
			};
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += reasoning;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: reasoning
				};
			}
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += content;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: content
				};
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (call.id !== void 0) block.callId = call.id;
				if (call.function?.name !== void 0) block.name = call.function.name;
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: ToolCallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
	}
	throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region \0@oxc-project+runtime@0.135.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
//#endregion
//#region src/adapter.ts
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
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.inputModalities ?? ["text"]
	};
}
/**
* Map an HTTP status to a stable LlmError code.
* @param status - status of a non-2xx provider response.
* @param error - parsed provider error body, when available.
* @returns the normalized harness error code.
*/
function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 413) return "INVALID_REQUEST";
	const detail = [
		error?.code,
		error?.type,
		error?.message
	].filter(Boolean).join(" ");
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (detail.length > 0 && /context.*(length|window|exceed)/i.test(detail)) return "CONTEXT_WINDOW_EXCEEDED";
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/**
* Build the CodeAgent-specific headers for one upstream request.
*
* These headers are aligned with the CodeAgent CLI and are required for the
* upstream routing layer to accept the request. The `x-auth-token` is the
* authToken from the Huawei IDEA secureLogin.
*/
function buildUpstreamHeaders(tokenData, accept = "text/event-stream") {
	return {
		"User-Agent": "codeagent",
		"x-auth-token": tokenData.token,
		"authorization": "Bearer",
		"app-id": "com.huawei.devmind.codebot.apibot",
		"plugin-version": "cli-1.2605.03-IN.2",
		"x-codeagent-request-kind": "main_conversation",
		"x-error-propagation": "true",
		"content-type": "application/json",
		"accept": accept
	};
}
/**
* The `LlmAdapter` for the Huawei CodeAgent/CodeMate upstream. One instance
* serves every model name it was registered under (the harness model name IS
* the wire model name).
*/
var HuaweiCodeAgentAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Huawei CodeAgent"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
	}
	async resolveModel(provider, model, signal) {
		const connection = this.config.options();
		const configured = await this.config.resolveCatalogModel?.(model, signal) ?? connection.models.find((entry) => entry.id === model);
		const contextWindow = configured?.contextWindow ?? 128e3;
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? 8192
		});
	}
	async *stream(options) {
		try {
			var _usingCtx$1 = _usingCtx();
			const connection = this.config.options();
			const tokenManager = this.config.tokenManager;
			const consumer = new AbortController();
			const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
			const watchdog = _usingCtx$1.u(idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE));
			let tokenData;
			try {
				tokenData = await tokenManager.getToken();
			} catch (error) {
				if (error instanceof LlmError) throw error;
				throw new LlmError("huawei-codeagent: failed to acquire auth token", "TRANSPORT", { cause: error });
			}
			const iterator = this.request(options, watchdog.signal, connection, tokenManager, tokenData, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`huawei-codeagent stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("huawei-codeagent request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError(`huawei-codeagent API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("huawei-codeagent stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch {}
			}
		} catch (_) {
			_usingCtx$1.e = _;
		} finally {
			_usingCtx$1.d();
		}
	}
	/**
	* Execute the upstream request and translate the SSE stream. On a 401
	* (token expired server-side before the 24h cache), force-refresh the
	* token and retry exactly once.
	*/
	async *request(options, signal, connection, tokenManager, tokenData, onComment) {
		const body = serializeRequest(options);
		const payload = JSON.stringify(body);
		let headers = buildUpstreamHeaders(tokenData);
		let response;
		try {
			response = await huaweiFetch(connection.baseURL, {
				method: "POST",
				headers,
				body: payload,
				signal
			});
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`huawei-codeagent API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (response.status === 401) {
			try {
				tokenData = await tokenManager.getToken(true);
			} catch (error) {
				if (error instanceof LlmError) throw error;
				throw new LlmError("huawei-codeagent: token refresh after 401 failed", "AUTH", { cause: error });
			}
			headers = buildUpstreamHeaders(tokenData);
			try {
				response = await huaweiFetch(connection.baseURL, {
					method: "POST",
					headers,
					body: payload,
					signal
				});
			} catch (error) {
				if (signal.aborted) throw error;
				throw new LlmError(`huawei-codeagent API retry request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			}
		}
		if (!response.ok) {
			let message = `huawei-codeagent API error (HTTP ${response.status})`;
			let providerError;
			try {
				providerError = (await response.json()).error;
				if (providerError?.message) message = providerError.message;
			} catch {}
			throw new LlmError(message, httpErrorCode(response.status, providerError), { status: response.status });
		}
		if (!response.body) throw new LlmError("huawei-codeagent API returned no response body", "EMPTY_RESPONSE");
		yield* translate(parseSse(response.body, onComment));
	}
};
//#endregion
//#region src/model-catalog.ts
const CATALOG_CACHE_MS = 360 * 60 * 1e3;
const CATALOG_FAILURE_CACHE_MS = 300 * 1e3;
const CATALOG_TIMEOUT_MS = 15e3;
const CODEAGENT_CLIENT_VERSION = "cli-1.2605.03-IN.2";
const USER_DETAIL_URL = "https://codeagentcli.rnd.huawei.com/codeAgentPro/auth/internal/getUserDetail";
function objectOf(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function positiveInteger(value) {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value !== "string" || !/^\d+$/u.test(value)) return void 0;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : void 0;
}
function numberAt(source, ...paths) {
	for (const path of paths) {
		let value = source;
		for (const segment of path) value = objectOf(value)?.[segment];
		const parsed = positiveInteger(value);
		if (parsed !== void 0) return parsed;
	}
}
function stringAt(source, ...keys) {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
}
function modalityObject(value) {
	if (typeof value !== "string") return objectOf(value);
	try {
		return objectOf(JSON.parse(value));
	} catch {
		return;
	}
}
function inputModalitiesOf(source) {
	const input = modalityObject(source.modalities)?.input;
	if (!Array.isArray(input)) return void 0;
	const modalities = input.filter((value) => value === "text" || value === "image");
	return modalities.length === 0 ? void 0 : [...new Set(modalities)];
}
function modelOf(value, fallbackId) {
	const source = objectOf(value);
	if (source === void 0) return void 0;
	const id = stringAt(source, "id", "model", "modelId", "model_id") ?? fallbackId;
	if (id === void 0 || id.length === 0) return void 0;
	const input = numberAt(source, ["input"], ["inputLength"], ["input_length"]);
	const output = numberAt(source, ["output"], ["outputLength"], ["output_length"]);
	const contextWindow = numberAt(source, ["context"], ["contextWindow"], ["context_window"], ["maxContextTokens"], ["max_context_tokens"], ["max_model_len"]);
	const maxTokens = numberAt(source, ["maxTokens"], ["max_tokens"], ["maxOutputTokens"], ["max_output_tokens"]) ?? output;
	const name = stringAt(source, "name", "displayName", "modelName", "model_name");
	const description = stringAt(source, "des", "description", "modelDesc", "model_desc");
	const inputModalities = inputModalitiesOf(source);
	return {
		id,
		...name === void 0 ? {} : { name },
		...description === void 0 ? {} : { description },
		...contextWindow === void 0 ? {} : { contextWindow },
		...maxTokens === void 0 ? {} : { maxTokens },
		...input === void 0 ? {} : { maxInputTokens: input },
		...inputModalities === void 0 ? {} : { inputModalities }
	};
}
function modelEntries(value) {
	if (Array.isArray(value)) return value;
	const root = objectOf(value);
	if (root === void 0) return [];
	for (const key of [
		"data",
		"modelList",
		"models",
		"result"
	]) if (Array.isArray(root[key])) return root[key];
	return [];
}
/** Parse CodeAgent catalog records, including routed models nested under Auto entries. */
function parseModelCatalog(payload) {
	const parsed = [];
	for (const entry of modelEntries(payload)) {
		const source = objectOf(entry);
		if (source === void 0) continue;
		const routed = Array.isArray(source.routModels) ? source.routModels : [];
		if (routed.length > 0) {
			for (const route of routed) {
				const routeSource = objectOf(route);
				const model = routeSource === void 0 ? void 0 : modelOf({
					...source,
					...routeSource,
					routModels: void 0
				});
				if (model !== void 0) parsed.push(model);
			}
			continue;
		}
		const model = modelOf(source);
		if (model !== void 0) parsed.push(model);
	}
	return [...new Map(parsed.map((model) => [model.id, model])).values()];
}
function mergeModels(configured, discovered) {
	const configuredById = new Map(configured.map((model) => [model.id, model]));
	const merged = discovered.map((model) => ({
		...model,
		...configuredById.get(model.id)
	}));
	const discoveredIds = new Set(discovered.map((model) => model.id));
	merged.push(...configured.filter((model) => !discoveredIds.has(model.id)).map((model) => ({ ...model })));
	return merged;
}
function userDetailOf(payload) {
	const root = objectOf(payload);
	const source = objectOf(root?.data) ?? objectOf(root?.result) ?? root;
	if (source === void 0) return {};
	const departmentPath = stringAt(source, "departmentPath", "department_path");
	const w3account = stringAt(source, "w3account", "w3Account", "account");
	const region = stringAt(source, "region", "area");
	return {
		...departmentPath === void 0 ? {} : { departmentPath },
		...w3account === void 0 ? {} : { w3account },
		...region === void 0 ? {} : { region }
	};
}
function userDetailHeaders(token) {
	return {
		"content-type": "application/json",
		"x-auth-token": token.token,
		"Agent-Type": "AgentCenter",
		"X-Language": "en-us"
	};
}
function catalogHeaders(token, detail, fallbackZone) {
	const region = detail.region?.toLowerCase();
	const area = region === "y" || region === "yellow" ? "yellow" : region === "g" || region === "green" ? "green" : fallbackZone;
	return {
		"content-type": "application/json",
		"User-Agent": "axios/1.18.1",
		"x-auth-token": token.token,
		"agent-type": "AgentCenter",
		area,
		"plugin-version": CODEAGENT_CLIENT_VERSION,
		"x-agent-client-version": CODEAGENT_CLIENT_VERSION,
		"x-language": "en-us",
		...detail.departmentPath === void 0 ? {} : {
			depart: detail.departmentPath,
			"x-agent-user-department": detail.departmentPath
		},
		...detail.w3account === void 0 ? {} : { "x-agent-user-account": detail.w3account }
	};
}
/** Cached best-effort reader for the Huawei CodeAgent model directory. */
var HuaweiModelCatalog = class {
	options;
	tokenManager;
	reportFailure;
	cache;
	constructor(options, tokenManager, reportFailure = () => {}) {
		this.options = options;
		this.tokenManager = tokenManager;
		this.reportFailure = reportFailure;
	}
	async fetchCodeAgent(connection, signal, forceToken = false) {
		const token = await this.tokenManager.getToken(forceToken);
		const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
		const requestSignal = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
		const detailResponse = await huaweiFetch(USER_DETAIL_URL, {
			method: "POST",
			headers: userDetailHeaders(token),
			body: "{}",
			signal: requestSignal
		});
		if (detailResponse.status === 401 && !forceToken) return this.fetchCodeAgent(connection, signal, true);
		let detail = {};
		if (detailResponse.ok) try {
			detail = userDetailOf(await detailResponse.json());
		} catch {}
		const url = new URL(connection.modelCatalogURL);
		url.searchParams.set("checkUserPermission", connection.filterModelsByPermission ? "TRUE" : "FALSE");
		const response = await huaweiFetch(url, {
			method: "GET",
			headers: catalogHeaders(token, detail, connection.zone),
			signal: requestSignal
		});
		if (response.status === 401 && !forceToken) return this.fetchCodeAgent(connection, signal, true);
		if (!response.ok) throw new LlmError(`huawei-codeagent model catalog error (HTTP ${response.status})`, `HTTP_${response.status}`);
		const discovered = parseModelCatalog(await response.json());
		if (discovered.length === 0) throw new Error("Huawei CodeAgent model catalog returned no readable models");
		return discovered;
	}
	async list(signal) {
		const connection = this.options();
		const key = JSON.stringify({
			service: connection.service,
			zone: connection.zone,
			url: connection.modelCatalogURL,
			filter: connection.filterModelsByPermission,
			models: connection.models
		});
		if (this.cache?.key === key && Date.now() < this.cache.expiresAt) return this.cache.models;
		if (connection.service !== "codeagent") return connection.models.map((model) => ({ ...model }));
		try {
			const discovered = await this.fetchCodeAgent(connection, signal);
			const models = mergeModels(connection.models, discovered);
			this.cache = {
				key,
				expiresAt: Date.now() + CATALOG_CACHE_MS,
				models
			};
			return models;
		} catch (error) {
			if (signal?.aborted === true) throw error;
			this.reportFailure(error);
			const models = connection.models.map((model) => ({ ...model }));
			this.cache = {
				key,
				expiresAt: Date.now() + CATALOG_FAILURE_CACHE_MS,
				models
			};
			return models;
		}
	}
	async resolve(model, signal) {
		return (await this.list(signal)).find((entry) => entry.id === model);
	}
};
//#endregion
//#region src/token-manager.ts
/**
* HuaweiTokenManager — TypeScript port of the Python `TokenManager`.
*
* Logs into `rnd-idea-api.huawei.com` with a Huawei domain account (工号 +
* password) to obtain a `cloudDragonTokens.authToken`, caches it for 24 hours,
* and refreshes on demand (forced or on expiry).
*
* The account and password arrive as separate values through the
* {@link CredentialResolver}; the password remains in DSH's credential store.
*
* The token is injected as the `x-auth-token` header on every upstream
* CodeAgent/CodeMate request. The department string (built from userInfo
* fields) is also cached for the CodeMate `department` header.
*
* @module dsh-llm-huawei-codeagent/token-manager
*/
/** Login API endpoint for Huawei IDEA secureLogin. */
const TOKEN_REFRESH_URL = "https://rnd-idea-api.huawei.com/ideaclientservice/login/v4/secureLogin";
/** Token cache duration in milliseconds (24 hours). */
const TOKEN_CACHE_DURATION_MS = 1440 * 60 * 1e3;
/**
* Token acquisition and cache manager for the Huawei CodeAgent/CodeMate
* upstream. One instance per adapter; the adapter constructs it once and
* reuses it for every request.
*/
var HuaweiTokenManager = class {
	resolveCredentials;
	cached;
	/** In-flight refresh promise; concurrent `getToken` callers share it. */
	inflight;
	constructor(resolveCredentials) {
		this.resolveCredentials = resolveCredentials;
	}
	/**
	* Get a valid token, refreshing the cache when it is missing or expired.
	* Concurrent callers share one in-flight refresh to avoid duplicate
	* logins.
	* @param force - when true, ignore the cache and refresh unconditionally.
	* @returns the cached token data.
	* @throws `LlmError` with code `AUTH` when the login fails (credential
	* invalid or network error).
	*/
	async getToken(force = false) {
		const cached = this.cached;
		if (!force && this.isValid(cached)) return cached;
		const result = await this.refresh();
		if (!result.ok) throw result.error;
		return result.data;
	}
	/** Whether a cached token is present and has not expired. */
	isValid(data) {
		return data !== void 0 && data.token.length > 0 && Date.now() < data.expiry;
	}
	/**
	* Execute one login attempt and cache the result. Multiple concurrent
	* callers share the same in-flight promise so only one HTTP login fires.
	*/
	async refresh() {
		if (this.inflight !== void 0) return this.inflight;
		this.inflight = (async () => {
			try {
				const { userId, userPwd } = await this.resolveCredentials();
				if (userId.length === 0 || userPwd.length === 0) return {
					ok: false,
					error: new LlmError("huawei-codeagent: 工号或密码未配置，请在 Models 页面分别填写工号和密码", "MISSING_CREDENTIAL")
				};
				const data = await this.doLogin(userId, userPwd);
				this.cached = data;
				return {
					ok: true,
					data
				};
			} catch (error) {
				if (error instanceof LlmError) return {
					ok: false,
					error
				};
				return {
					ok: false,
					error: new LlmError(`huawei-codeagent: 登录请求异常（网络/代理错误），请检查内网连通性: ${String(error)}`, "TRANSPORT", { cause: error })
				};
			} finally {
				this.inflight = void 0;
			}
		})();
		return this.inflight;
	}
	/**
	* Execute one login POST and parse the response.
	* @throws `LlmError` `AUTH` when the login succeeds but returns no
	* authToken (password invalid), `TRANSPORT` on a network/parse error.
	*/
	async doLogin(userId, userPwd) {
		let response;
		try {
			response = await huaweiFetch(TOKEN_REFRESH_URL, {
				method: "POST",
				headers: {
					"X-Language": "en",
					"Content-Type": "application/json; charset=UTF-8",
					"x-requested-with": "XMLHttpRequest",
					"X-User-Id": userId
				},
				body: JSON.stringify({
					user: userId,
					password: userPwd,
					requireUserInfo: true,
					appName: "vscodehuawei",
					oauthApp: "vscodehuawei",
					requireCodeHubOpenToken: true
				})
			});
		} catch (error) {
			throw new LlmError(`huawei-codeagent: 登录请求失败（网络错误）: ${String(error)}`, "TRANSPORT", { cause: error });
		}
		let body;
		try {
			body = await response.json();
		} catch (error) {
			throw new LlmError(`huawei-codeagent: 登录响应解析失败 (HTTP ${response.status})`, "TRANSPORT", { cause: error });
		}
		const token = body.cloudDragonTokens?.authToken;
		if (token === void 0 || token.length === 0) throw new LlmError("huawei-codeagent: 域账号密码可能已失效，请在 Models 页面更新工号或密码", "AUTH");
		const u = body.userInfo ?? {};
		return {
			token,
			department: encodeURIComponent([
				u.hwDepartName1 ?? "",
				u.hwDepartName2 ?? "",
				u.hwDepartName3 ?? "",
				u.hwDepartName4 ?? "",
				u.hwDepartName5 ?? "",
				u.hwDepartName6 ?? ""
			].join("/")),
			expiry: Date.now() + TOKEN_CACHE_DURATION_MS
		};
	}
};
//#endregion
//#region src/index.ts
const name = "llm-huawei-codeagent";
const inject = ["llm"];
const NS = "llm-huawei-codeagent";
const DEFAULT_PASSWORD_ENV = "HUAWEI_CODEAGENT_PASSWORD";
const DEFAULT_MODEL_CATALOG_URL = "https://codeagentcli.rnd.huawei.com/codeAgentPro/chat/modles";
/** The single provider route this plugin owns. */
const PROVIDER = "huawei-codeagent";
/** Default models advertised by the adapter (from the CodeAgent catalog). */
const DEFAULT_MODELS = [
	{
		id: "maas-glm-5.2-zhipu",
		name: "GLM 5.2 (Zhipu)"
	},
	{
		id: "maas-glm-5.2-aliyun",
		name: "GLM 5.2 (Aliyun)"
	},
	{
		id: "maas-glm-5.2-volcengine-codeagent",
		name: "GLM 5.2 (Volcengine)"
	},
	{
		id: "maas-qwen3.7-max",
		name: "Qwen 3.7 Max"
	},
	{
		id: "maas-qwen3.7-plus",
		name: "Qwen 3.7 Plus"
	},
	{
		id: "maas-glm-5.1-zhipu",
		name: "GLM 5.1 (Zhipu)"
	},
	{
		id: "maas-MiniMax-M3",
		name: "MiniMax M3"
	},
	{
		id: "GLM-5.1-CodeAgent",
		name: "GLM 5.1 CodeAgent"
	},
	{
		id: "maas-glm-5-aliyun-codeagent",
		name: "GLM 5 (Aliyun CodeAgent)"
	},
	{
		id: "Qwen3.6-27B-VL",
		name: "Qwen 3.6 27B VL"
	},
	{
		id: "MiniMax-M2.7",
		name: "MiniMax M2.7"
	}
];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	maxInputTokens: z.number().step(1).min(1),
	inputModalities: z.array(z.union(["text", "image"])).min(1)
});
const Config = z.object({
	userId: z.string(),
	passwordEnv: z.string().role("credential-ref").default(DEFAULT_PASSWORD_ENV),
	service: z.union(["codeagent", "codemate"]).default("codeagent"),
	zone: z.union(["green", "yellow"]).default("green"),
	baseURL: z.string(),
	modelCatalogURL: z.string().default(DEFAULT_MODEL_CATALOG_URL),
	filterModelsByPermission: z.boolean().default(false),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/**
* Default upstream endpoint URL for a service/zone combination. The green zone
* is the default; yellow is the alternate network zone.
*/
function defaultBaseURL(service, zone) {
	const zoneCode = zone === "yellow" ? "y" : "g";
	if (service === "codemate") return `https://snapengine.codemate.cce.prod-kwe-${zoneCode}.dragon.tools.huawei.com/api/v2/chat/completions`;
	return `https://snapengine.cida.cce.prod-szv-${zoneCode}.dragon.tools.huawei.com/api/v2/chat/completions`;
}
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-huawei-codeagent: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-huawei-codeagent: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-huawei-codeagent: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-huawei-codeagent: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (model.maxInputTokens !== void 0 && (!Number.isInteger(model.maxInputTokens) || model.maxInputTokens <= 0)) throw new Error(`llm-huawei-codeagent: catalog model "${model.id}" maxInputTokens must be a positive integer`);
		if (seen.has(model.id)) throw new Error(`llm-huawei-codeagent: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.maxInputTokens === void 0 ? {} : { maxInputTokens: model.maxInputTokens },
			...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }
		};
	});
}
/**
* The one explicit resolve step from raw config to validated connection
* facts. Programmatic construction may bypass Schemastery normalization, so
* every default and bound is re-judged here.
* @param config - raw plugin config or resolved settings snapshot.
* @returns validated connection facts.
*/
function resolveAdapterOptions(config) {
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-huawei-codeagent: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const service = config.service ?? "codeagent";
	const zone = config.zone ?? "green";
	return {
		service,
		zone,
		baseURL: config.baseURL ?? defaultBaseURL(service, zone),
		modelCatalogURL: config.modelCatalogURL ?? DEFAULT_MODEL_CATALOG_URL,
		filterModelsByPermission: config.filterModelsByPermission ?? false,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-huawei-codeagent: retryPolicy")
	};
}
/**
* Build a credential resolver that reads the account from settings and the
* password from the credential seam (or the environment as a fallback).
* The resolver is per-call so edited settings and rotated passwords reach the
* next login without restarting DSH.
*/
function createCredentialResolver(ctx, config) {
	return async () => {
		const current = config();
		const userId = current.userId?.trim() ?? "";
		const passwordRef = credentialRef(current.passwordEnv ?? DEFAULT_PASSWORD_ENV);
		if (userId.length === 0) throw new LlmError("llm-huawei-codeagent: 工号未配置，请在 Models 页面填写华为工号", "MISSING_CREDENTIAL");
		let userPwd;
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(passwordRef);
			if (hit !== void 0) userPwd = hit.value;
		} else {
			const entry = launchEnvironmentOf(ctx).get(passwordRef);
			if (entry !== void 0 && entry.value.length > 0) userPwd = entry.value;
		}
		if (userPwd === void 0 || userPwd.length === 0) throw new LlmError(`llm-huawei-codeagent: 密码未配置，请在 Models 页面填写密码，或导出环境变量 ${passwordRef}`, "MISSING_CREDENTIAL");
		return {
			userId,
			userPwd
		};
	};
}
/**
* Answer the Models page "Fetch available models" action. The adapter
* already knows its catalog, so this returns the configured model list
* directly — no network call needed. A route the adapter ships (provider
* !== undefined) is answered from the catalog; a draft being composed
* (provider === undefined) gets the full default catalog so the user can
* adopt from it.
*/
function discoverModels(_request, models) {
	const catalog = models();
	return Promise.resolve(catalog.map((model) => ({
		id: model.id,
		...model.name === void 0 ? {} : { name: model.name },
		...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
		...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
	})));
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-huawei-codeagent: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const tokenManager = new HuaweiTokenManager(createCredentialResolver(ctx, current));
	const modelCatalog = new HuaweiModelCatalog(options, tokenManager, (error) => {
		ctx.logger.warn(`llm-huawei-codeagent: model catalog unavailable, using static fallback: ${String(error)}`);
	});
	const adapter = new HuaweiCodeAgentAdapter({
		options,
		tokenManager,
		resolveCatalogModel: (model, signal) => modelCatalog.resolve(model, signal)
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Huawei CodeAgent",
		settingsNs: NS,
		settingsPath: []
	}]);
	ctx.llm.registerModelDiscovery(NS, async (request) => {
		const models = await modelCatalog.list();
		return discoverModels(request, () => models);
	});
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, NS, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: ensureRegistrationFacts
		});
	});
}
//#endregion
export { Config, DEFAULT_STREAM_IDLE_TIMEOUT_MS, HuaweiCodeAgentAdapter, HuaweiTokenManager, apply, inject, name, parseModelCatalog, resolveAdapterOptions };
