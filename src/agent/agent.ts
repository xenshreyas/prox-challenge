/**
 * The agent runtime: wraps the Claude Agent SDK `query()` loop and translates
 * its message stream into the `AgentEvent` union the transport forwards.
 *
 * Notes:
 * - We use streaming-input mode (an async generator of `SDKUserMessage`) rather
 *   than a plain string prompt. It costs a little ceremony but is required if we
 *   ever want to attach a user-supplied photo ("here's my control panel, which
 *   knob is this?"), which is a natural extension for this product.
 * - `includePartialMessages: true` gives token-level deltas so the UI streams
 *   text as it is generated instead of blocking on whole turns.
 * - The SDK's message union grows between patch releases, so the switch is
 *   deliberately tolerant: unknown message types are ignored rather than thrown.
 */

import {
	query,
	startup,
	type HookCallback,
	type PostToolUseHookInput,
	type SDKUserMessage,
	type StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { SYSTEM_PROMPT, voltageContext } from './prompt.js';
import {
	artifactInstructionForQuestion,
	artifactRequirementForQuestion,
	createManualTools,
	MANUAL_TOOL_NAMES,
} from './tools.js';
import type { AgentEvent } from './events.js';

export interface AskOptions {
	question: string;
	/** Resume a prior conversation so follow-ups keep context. */
	sessionId?: string | null;
	/** Known input voltage, to skip the most common clarifying question. */
	voltage?: 120 | 240 | null;
	/** Optional user-supplied image (data URL or raw base64 PNG/JPEG). */
	image?: { data: string; mediaType: 'image/png' | 'image/jpeg' } | null;
	signal?: AbortSignal;
	model?: string;
}

export class MissingApiKeyError extends Error {
	constructor() {
		super(
			'No model credentials found. Copy .env.example to .env and add ANTHROPIC_API_KEY from https://console.anthropic.com/settings/keys',
		);
		this.name = 'MissingApiKeyError';
	}
}

/**
 * The SDK accepts credentials three ways, and we support all of them:
 *   ANTHROPIC_API_KEY   — the normal path a grader will use
 *   ANTHROPIC_AUTH_TOKEN — bearer token, used with a custom endpoint
 *   ANTHROPIC_BASE_URL  — a compatible endpoint that may need no auth at all
 *                          (this is how the dev-only Copilot proxy runs)
 */
export function assertConfigured(): void {
	const hasCreds =
		process.env.ANTHROPIC_API_KEY?.trim() ||
		process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
		process.env.ANTHROPIC_BASE_URL?.trim();
	if (!hasCreds) throw new MissingApiKeyError();
}

/**
 * One bounded stop-hook retry for the artifact rule. Tool-result reminders are
 * usually enough, but measured full runs still showed the model claiming it had
 * built a calculator without ever calling create_artifact. The stop hook turns
 * that stochastic suggestion into a runtime invariant without risking a loop.
 */
export function artifactStopFeedback(
	question: string,
	artifactCreated: boolean,
	stopHookActive: boolean,
): string | null {
	if (artifactCreated || stopHookActive) return null;
	const instruction = artifactInstructionForQuestion(question);
	if (!instruction) return null;
	return (
		'This answer requires an interactive artifact and none has been created. ' +
		'Before stopping, call mcp__manual__create_artifact (create_artifact) and build ' +
		`${instruction}. Make it complete and self-contained from the manual evidence you retrieved. ` +
		'Do not merely describe an artifact.'
	);
}

/**
 * Holds prose produced before a required artifact exists. A Stop-hook retry can
 * otherwise stream one complete answer, create the artifact, and then append a
 * second complete answer to the same UI message. If the bounded retry still
 * fails, `finish()` releases the prose instead of leaving the user empty-handed.
 */
export class ArtifactAnswerGate {
	private currentAttempt = '';
	private latestAttempt = '';
	artifactCreated = false;

	constructor(private readonly required: boolean) {}

	accept(text: string): string {
		if (!this.required || this.artifactCreated) return text;
		this.currentAttempt += text;
		return '';
	}

	endAttempt(): void {
		if (!this.required || this.artifactCreated || !this.currentAttempt) return;
		this.latestAttempt = this.currentAttempt;
		this.currentAttempt = '';
	}

	markArtifactCreated(): void {
		this.artifactCreated = true;
		this.currentAttempt = '';
		this.latestAttempt = '';
	}

	finish(): string {
		this.endAttempt();
		const text = this.latestAttempt;
		this.latestAttempt = '';
		return text;
	}
}

/** Pre-warms the SDK subprocess at boot so the first question isn't slow. */
export async function warmUp(): Promise<void> {
	try {
		assertConfigured();
	} catch {
		return;
	}
	try {
		await startup();
	} catch {
		// Warm-up is an optimization; a failure here must not block the server.
	}
}

function buildPrompt(opts: AskOptions): AsyncGenerator<SDKUserMessage> {
	async function* gen(): AsyncGenerator<SDKUserMessage> {
		const content: SDKUserMessage['message']['content'] = [];
		if (opts.image) {
			const data = opts.image.data.replace(/^data:[^;]+;base64,/, '');
			content.push({
				type: 'image',
				// User-message image blocks use `media_type` (snake_case). Tool
				// *results* use `mimeType`. They are not interchangeable.
				source: { type: 'base64', media_type: opts.image.mediaType, data },
			});
		}
		content.push({ type: 'text', text: opts.question });
		yield {
			type: 'user',
			parent_tool_use_id: null,
			message: { role: 'user', content },
		} as SDKUserMessage;
	}
	return gen();
}

/**
 * Runs one question and yields UI events.
 *
 * Errors are yielded as `error` events rather than thrown, so a transport that
 * has already flushed SSE headers can still deliver a useful message.
 */
export async function* ask(opts: AskOptions): AsyncGenerator<AgentEvent> {
	// The tool layer emits side-channel events (figures, artifacts, citations)
	// synchronously from inside tool handlers, which run while we're awaiting the
	// SDK stream. We buffer them here and drain between SDK messages.
	const pending: AgentEvent[] = [];
	const tools = createManualTools({ emit: (e) => pending.push(e), userQuestion: opts.question });
	const answerGate = new ArtifactAnswerGate(Boolean(artifactRequirementForQuestion(opts.question)));
	const trackArtifact: HookCallback = async (input) => {
		if (
			input.hook_event_name === 'PostToolUse' &&
			(input as PostToolUseHookInput).tool_name === 'mcp__manual__create_artifact'
		) {
			answerGate.markArtifactCreated();
		}
		return {};
	};
	const requireArtifactBeforeStop: HookCallback = async (input) => {
		if (input.hook_event_name !== 'Stop') return {};
		const stop = input as StopHookInput;
		const feedback = artifactStopFeedback(
			opts.question,
			answerGate.artifactCreated,
			stop.stop_hook_active,
		);
		return feedback
			? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: feedback } }
			: {};
	};

	let sessionId: string | null = opts.sessionId ?? null;

	try {
		assertConfigured();
	} catch (err) {
		yield {
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
			isConfigError: true,
		};
		yield { type: 'done', sessionId: null };
		return;
	}

	try {
		const stream = query({
			prompt: buildPrompt(opts),
			options: {
				systemPrompt: SYSTEM_PROMPT + voltageContext(opts.voltage ?? null),
				model: opts.model,
				mcpServers: { manual: tools },
				allowedTools: MANUAL_TOOL_NAMES,
				// The agent has no business touching the filesystem or a shell; its
				// entire world is the manual tools above.
				disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				includePartialMessages: true,
				maxTurns: 24,
				hooks: {
					PostToolUse: [{ matcher: 'mcp__manual__create_artifact', hooks: [trackArtifact] }],
					Stop: [{ hooks: [requireArtifactBeforeStop] }],
				},
				...(sessionId ? { resume: sessionId } : {}),
				...(opts.signal ? { abortController: toAbortController(opts.signal) } : {}),
			},
		});

		for await (const msg of stream) {
			while (pending.length) yield pending.shift()!;

			switch (msg.type) {
				case 'system': {
					if (msg.subtype === 'init') sessionId = msg.session_id;
					break;
				}
				case 'stream_event': {
					const ev = msg.event as {
						type?: string;
						delta?: { type?: string; text?: string };
					};
					if (
						ev.type === 'content_block_delta' &&
						ev.delta?.type === 'text_delta' &&
						ev.delta.text
					) {
						const text = answerGate.accept(ev.delta.text);
						if (text) yield { type: 'token', text };
					}
					break;
				}
				case 'assistant': {
					for (const block of msg.message.content) {
						if (block.type === 'tool_use') {
							yield { type: 'tool', name: block.name, input: block.input };
						}
					}
					answerGate.endAttempt();
					break;
				}
				case 'result': {
					while (pending.length) yield pending.shift()!;
					const fallbackAnswer = answerGate.finish();
					if (fallbackAnswer) yield { type: 'token', text: fallbackAnswer };
					if (msg.subtype !== 'success') {
						yield {
							type: 'error',
							message: `Agent stopped: ${msg.subtype}. ${describeFailure(msg.subtype)}`,
						};
					}
					yield {
						type: 'done',
						sessionId: msg.session_id ?? sessionId,
						costUsd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
						durationMs: 'duration_ms' in msg ? msg.duration_ms : undefined,
					};
					return;
				}
				default:
					break;
			}
		}

		while (pending.length) yield pending.shift()!;
		const fallbackAnswer = answerGate.finish();
		if (fallbackAnswer) yield { type: 'token', text: fallbackAnswer };
		yield { type: 'done', sessionId };
	} catch (err) {
		const fallbackAnswer = answerGate.finish();
		if (fallbackAnswer) yield { type: 'token', text: fallbackAnswer };
		const message = err instanceof Error ? err.message : String(err);
		const isAuth = /api[_ ]?key|401|unauthor|authentication/i.test(message);
		yield { type: 'error', message, isConfigError: isAuth };
		yield { type: 'done', sessionId };
	}
}

function toAbortController(signal: AbortSignal): AbortController {
	const ac = new AbortController();
	if (signal.aborted) ac.abort();
	else signal.addEventListener('abort', () => ac.abort(), { once: true });
	return ac;
}

function describeFailure(subtype: string): string {
	switch (subtype) {
		case 'error_max_turns':
			return 'It used all its tool turns without finishing. Try a narrower question.';
		case 'error_max_budget_usd':
			return 'The per-request cost budget was exhausted.';
		default:
			return 'Please try again.';
	}
}
