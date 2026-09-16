/**
 * Huawei CodeAgent chat-completions wire format (OpenAI-compatible) and login
 * response types. Types only.
 *
 * The upstream CodeAgent/CodeMate service speaks standard OpenAI Chat
 * Completions for both request and streaming response. The login API at
 * `rnd-idea-api.huawei.com` returns a JSON body containing
 * `cloudDragonTokens.authToken`.
 *
 * @module dsh-llm-huawei-codeagent/types
 */
/** Request body for `POST {baseURL}/api/v2/chat/completions`. */
export interface WireRequest {
    model: string;
    messages: WireMessage[];
    stream: true;
    stream_options?: {
        include_usage: true;
    };
    tools?: WireTool[];
    temperature?: number;
    max_tokens?: number;
    stop?: string[];
}
/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
    role: 'system';
    content: string;
}
/** User-role message: text-only string content. */
export interface WireUserMessage {
    role: 'user';
    content: string;
}
/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
    role: 'tool';
    tool_call_id: string;
    content: string;
}
/** Assistant-role history message. */
export interface WireAssistantMessage {
    role: 'assistant';
    content: string;
    reasoning_content?: string;
    tool_calls?: WireToolCall[];
}
/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage = WireSystemMessage | WireUserMessage | WireAssistantMessage | WireToolMessage;
/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
    choices?: WireChoice[];
    /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
    usage?: WireUsage | null;
}
/** One streamed choice; `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
    delta?: WireDelta;
    finish_reason?: string | null;
}
/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
    role?: string;
    /** Visible text. Null/empty on reasoning/tool-call chunks. */
    content?: string | null;
    /** Thinking-mode CoT (reasoning chain). */
    reasoning_content?: string | null;
    tool_calls?: WireToolCallDelta[];
}
/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
    /** Disambiguates parallel tool calls; stable across a call's deltas. */
    index: number;
    /** Present on the first delta of each call only. */
    id?: string;
    type?: 'function';
    function?: {
        /** Present on the first delta of each call only. */
        name?: string;
        /** Argument JSON fragment (concatenate across deltas). */
        arguments?: string;
    };
}
/** Wire token accounting. */
export interface WireUsage {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
}
/** Non-2xx error body. */
export interface WireError {
    error?: {
        message?: string;
        type?: string;
        code?: string;
    };
}
/** Response from `rnd-idea-api.huawei.com/.../secureLogin`. */
export interface WireLoginResponse {
    cloudDragonTokens?: {
        authToken?: string;
    };
    userInfo?: WireUserInfo;
}
/** User info returned by the login API; department fields build the `department` header. */
export interface WireUserInfo {
    hwDepartName1?: string;
    hwDepartName2?: string;
    hwDepartName3?: string;
    hwDepartName4?: string;
    hwDepartName5?: string;
    hwDepartName6?: string;
}
//# sourceMappingURL=types.d.ts.map