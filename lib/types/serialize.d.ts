/**
 * Serialize harness messages into Huawei CodeAgent chat completions. The
 * upstream speaks standard OpenAI Chat Completions, so the serialization
 * follows the same structure as the DeepSeek adapter's, minus the
 * thinking-mode and image-capable paths (text-only for the initial version).
 *
 * Tool-result blocks become standalone `{role: 'tool'}` messages; assistant
 * reasoning is passed back as `reasoning_content` for CoT continuity.
 *
 * @module dsh-llm-huawei-codeagent/serialize
 */
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { WireMessage, WireRequest } from './types.ts';
/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export declare function serializeMessages(messages: Message[]): WireMessage[];
/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the chat-completions request body.
 */
export declare function serializeRequest(options: GenerateOptions): WireRequest;
//# sourceMappingURL=serialize.d.ts.map