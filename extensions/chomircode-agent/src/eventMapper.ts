/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { pandaResolvePermission, pandaResolveTeamPermission, pandaSetRuntime } from './pandaClient';

/**
 * Map full panda SSE events → Chat UI (progress, tools, permissions, usage, etc.).
 *
 * Keep the persisted transcript lean (Cursor-like): avoid flooding `progress`
 * and tool chatter into the response parts — those inflate session logs and
 * often leave only user bubbles after reopen.
 */
export class PandaEventMapper {
	private streamedAssistant = false;
	private lastStatus = '';
	private usageLine = '';
	private assistantBuf = '';
	private lastToolName = '';
	/** True while an inline permission / clarification UI is awaiting the user. */
	private awaitingUserInput = false;

	constructor(
		private readonly stream: vscode.ChatResponseStream,
		private readonly baseUrl: string,
		private readonly projectRoot: string,
	) { }

	async handle(event: string, data: Record<string, unknown>): Promise<void> {
		switch (event) {
			case 'started':
			case 'step':
			case 'panda_status': {
				const msg = String(data.message || data.status || data.text || '').trim();
				const phase = String(data.phase || '');
				if (phase === 'compact' || /compact/i.test(msg)) {
					this.stream.markdown(`\n\n🧩 _${msg || 'Context compacted'}_\n\n`);
					break;
				}
				// Don't spam "仍在等待权限…" while the inline picker is already shown
				if (this.awaitingUserInput && (phase === 'permission' || /等待权限|Waiting for permission/i.test(msg))) {
					break;
				}
				// Only surface a short progress line for LLM/permission waits — not every Round/tool tick
				if (!msg || msg === this.lastStatus) {
					break;
				}
				// Never surface Round N / tool-loop counters — looks amateur vs Cursor
				if (/^Round\s+\d+/i.test(msg) || /\/\d+\s*·/.test(msg)) {
					break;
				}
				const keep =
					phase === 'llm' ||
					phase === 'llm_stream' ||
					phase === 'llm_thinking' ||
					phase === 'permission' ||
					/调用模型|Thinking|等待权限|Starting ChomirCode|引擎已连接|模型输出|思考中/i.test(msg);
				if (keep) {
					this.lastStatus = msg;
					this.stream.progress(msg);
				}
				break;
			}
			case 'panda_stream': {
				const kind = String(data.kind || 'text');
				const delta = String(data.chunk ?? data.delta ?? data.text ?? data.content ?? '');
				if (!delta) {
					break;
				}
				if (kind === 'thinking') {
					this.stream.progress('Thinking…');
					break;
				}
				this.stream.markdown(delta);
				this.streamedAssistant = true;
				this.assistantBuf += delta;
				break;
			}
			case 'panda_stream_end': {
				const kind = String(data.kind || 'text');
				const content = String(data.content || '');
				if (kind === 'text' && content && !this.streamedAssistant) {
					this.stream.markdown(content);
					this.streamedAssistant = true;
					this.assistantBuf = content;
				} else if (kind === 'text' && content && !this.assistantBuf) {
					this.assistantBuf = content;
				}
				break;
			}
			case 'panda_block': {
				await this.handleBlock(data);
				break;
			}
			case 'panda_permission': {
				await this.handlePermission(data);
				break;
			}
			case 'panda_team_permission': {
				await this.handleTeamPermission(data);
				break;
			}
			case 'panda_mcp_oauth': {
				const url = String(data.url || data.authUrl || data.authorizeUrl || '');
				this.stream.markdown(`\n\n🔐 **MCP OAuth required**${url ? `: [Open authorization](${url})` : ''}\n\n`);
				if (url) {
					void vscode.env.openExternal(vscode.Uri.parse(url));
				}
				break;
			}
			case 'clarification': {
				await this.handleClarification(data);
				break;
			}
			case 'panda_todos': {
				const todos = data.todos || data.items;
				if (Array.isArray(todos) && todos.length) {
					this.stream.markdown('\n\n**Todos**\n');
					for (const t of todos) {
						const text = typeof t === 'string' ? t : String((t as any)?.content || (t as any)?.text || JSON.stringify(t));
						const done = !!(t as any)?.done || (t as any)?.status === 'completed';
						this.stream.markdown(`- ${done ? '✅' : '⬜'} ${text}\n`);
					}
					this.stream.markdown('\n');
				}
				break;
			}
			case 'panda_usage':
			case 'panda_context': {
				const parts: string[] = [];
				if (data.inputTokens != null || data.promptTokens != null) {
					parts.push(`in:${data.inputTokens ?? data.promptTokens}`);
				}
				if (data.outputTokens != null || data.completionTokens != null) {
					parts.push(`out:${data.outputTokens ?? data.completionTokens}`);
				}
				if (data.cost != null || data.totalCost != null) {
					parts.push(`$${data.cost ?? data.totalCost}`);
				}
				if (data.percent != null || data.contextPercent != null) {
					parts.push(`ctx:${data.percent ?? data.contextPercent}%`);
				}
				if (parts.length) {
					this.usageLine = parts.join(' · ');
				}
				break;
			}
			case 'panda_mode':
			case 'panda_round':
			case 'error': {
				if (event === 'error') {
					const msg = String(data.message || data.error || 'error');
					this.stream.markdown(`\n\n**Error:** ${msg}\n`);
				}
				break;
			}
			case 'panda_worktree': {
				const wt = String(data.path || data.worktree || data.name || '');
				if (wt) {
					this.stream.markdown(`\n_Worktree: \`${wt}\`_\n`);
				}
				break;
			}
			case 'done':
			case 'answer_done':
			case 'kind':
			case 'analyze':
			case 'changed':
				break;
			default:
				break;
		}
	}

	getUsageLine(): string {
		return this.usageLine;
	}

	didStreamAssistant(): boolean {
		return this.streamedAssistant;
	}

	getAssistantText(): string {
		return this.assistantBuf.trim();
	}

	private async handleBlock(data: Record<string, unknown>): Promise<void> {
		const type = String(data.type || '');
		const content = String(data.content || data.text || '');
		const streaming = !!data.streaming;
		switch (type) {
			case 'assistant_text':
				if (streaming && !content) {
					break;
				}
				if (content && !this.streamedAssistant) {
					this.stream.markdown(content);
					this.streamedAssistant = true;
					this.assistantBuf = content;
				} else if (content && !this.assistantBuf) {
					this.assistantBuf = content;
				}
				break;
			case 'thinking':
				// Don't persist long thinking blocks into chat history
				break;
			case 'tool_use':
			case 'tool_status': {
				const name = String(data.name || data.tool || 'tool');
				if (name !== this.lastToolName) {
					this.lastToolName = name;
					this.stream.markdown(`\n🔧 \`${name}\`\n`);
					this.stream.progress(`Tool: ${name}`);
				}
				break;
			}
			case 'tool_result': {
				const name = String(data.name || data.tool || '');
				const preview = truncate(content || String(data.result || ''), 180);
				if (preview) {
					this.stream.markdown(`\n↳ ${name ? `\`${name}\` ` : ''}${preview}\n`);
				}
				break;
			}
			case 'system':
				if (content) {
					if (/compact/i.test(content)) {
						this.stream.markdown(`\n\n🧩 _${content}_\n\n`);
					}
					// Skip other system noise so history stays readable after reopen
				}
				break;
			case 'user':
				break;
			default:
				break;
		}
	}

	private async handlePermission(data: Record<string, unknown>): Promise<void> {
		const id = String(data.id || data.permissionId || '');
		const tool = String(data.tool || data.name || 'tool');
		const reason = String(data.reason || data.description || data.command || data.path || '');

		this.awaitingUserInput = true;
		this.stream.progress(`Waiting for permission: ${tool}`);

		let choice: PermissionChoice = 'deny';
		try {
			const picked = await this.askInlineChoice(
				`Permission: ${tool}`,
				reason ? truncate(reason, 300) : 'Allow this tool action?',
				[
					{ id: 'allow', label: 'Allow once', value: 'allow' },
					{ id: 'session', label: 'Allow for this session', value: 'session' },
					{ id: 'persist', label: 'Allow and remember', value: 'persist' },
					{ id: 'autoRun', label: 'Allow all (auto-run)', value: 'autoRun' },
					{ id: 'deny', label: 'Deny', value: 'deny' },
					{ id: 'persistDeny', label: 'Deny and remember', value: 'persistDeny' },
				],
				'allow',
			);
			choice = asPermissionChoice(picked);
		} finally {
			this.awaitingUserInput = false;
		}

		if (choice === 'autoRun') {
			await vscode.workspace.getConfiguration('chomircode').update(
				'permissionMode',
				'bypassPermissions',
				vscode.ConfigurationTarget.Global,
			);
			const sessionId = String(data.sessionId || '');
			if (sessionId) {
				await pandaSetRuntime(this.baseUrl, {
					sessionId,
					permissionMode: 'bypassPermissions',
					agentMode: 'panda',
				}).catch(() => false);
			}
		}

		const allow = choice === 'allow' || choice === 'session' || choice === 'persist' || choice === 'autoRun';
		if (id) {
			await pandaResolvePermission(this.baseUrl, {
				id,
				allow,
				sessionAllow: choice === 'session' || choice === 'autoRun',
				persistAllow: choice === 'persist',
				persistDeny: choice === 'persistDeny',
				sessionDeny: choice === 'deny',
				projectRoot: this.projectRoot,
				sessionId: data.sessionId,
			});
		}
		const labels: Record<PermissionChoice, string> = {
			allow: 'Allowed once',
			session: 'Allowed for this session',
			persist: 'Allowed and remembered',
			autoRun: 'Auto-run enabled — remaining tools will run without asking',
			deny: 'Denied',
			persistDeny: 'Denied and remembered',
		};
		this.stream.markdown(`\n_${labels[choice]}_\n`);
	}

	private async handleTeamPermission(data: Record<string, unknown>): Promise<void> {
		const id = String(data.id || '');
		const member = String(data.member || data.agent || 'member');
		const tool = String(data.tool || data.name || 'tool');

		this.awaitingUserInput = true;
		let choice: PermissionChoice = 'deny';
		try {
			const picked = await this.askInlineChoice(
				`Team permission · ${member}`,
				`Allow \`${tool}\`?`,
				[
					{ id: 'allow', label: 'Allow', value: 'allow' },
					{ id: 'deny', label: 'Deny', value: 'deny' },
				],
				'allow',
			);
			choice = asPermissionChoice(picked);
		} finally {
			this.awaitingUserInput = false;
		}

		const allow = choice === 'allow';
		if (id) {
			await pandaResolveTeamPermission(this.baseUrl, { id, allow, ...data });
		}
		this.stream.markdown(`\n_${allow ? 'Allowed' : 'Denied'}_\n`);
	}

	private async handleClarification(data: Record<string, unknown>): Promise<void> {
		const question = String(data.question || data.message || data.prompt || 'Need clarification');
		const options = Array.isArray(data.options) ? data.options.map(String) : [];
		if (!options.length) {
			this.stream.markdown(`\n\n❓ ${question}\n\n`);
			return;
		}

		this.awaitingUserInput = true;
		try {
			const choice = await this.askInlineChoice(
				'Clarification needed',
				question,
				options.map(o => ({ id: o, label: o, value: o })),
				options[0],
			);
			if (choice) {
				this.stream.markdown(`\n_Selected: ${choice}_\n`);
				await vscode.env.clipboard.writeText(choice);
			}
		} finally {
			this.awaitingUserInput = false;
		}
	}

	/**
	 * Cursor-style inline choice in the chat thread (not a top-of-window Quick Pick).
	 * Uses Chat questionCarousel when available; falls back to Quick Pick.
	 */
	private async askInlineChoice(
		title: string,
		message: string,
		options: Array<{ id: string; label: string; value: string }>,
		defaultId: string,
	): Promise<PermissionChoice | string> {
		const streamAny = this.stream as vscode.ChatResponseStream & {
			questionCarousel?(questions: vscode.ChatQuestion[], allowSkip?: boolean): Thenable<Record<string, unknown> | undefined>;
		};

		if (typeof streamAny.questionCarousel === 'function' && typeof vscode.ChatQuestion === 'function') {
			const answers = await streamAny.questionCarousel([
				new vscode.ChatQuestion(
					'choice',
					vscode.ChatQuestionType.SingleSelect,
					title,
					{
						message,
						options: options.map(o => ({ id: o.id, label: o.label, value: o.value })),
						defaultValue: defaultId,
						allowFreeformInput: false,
					},
				),
			], true /* skip = deny */);

			const raw = answers?.['choice'];
			const selected = normalizeSingleSelectAnswer(raw);
			if (selected) {
				return selected;
			}
			return 'deny';
		}

		// Fallback for hosts without questionCarousel
		const pick = await vscode.window.showQuickPick(
			options.map(o => ({ label: o.label, id: o.id, value: o.value })),
			{ title, placeHolder: message, ignoreFocusOut: true },
		);
		return pick?.value || 'deny';
	}
}

type PermissionChoice = 'allow' | 'session' | 'persist' | 'autoRun' | 'deny' | 'persistDeny';

function asPermissionChoice(value: string): PermissionChoice {
	switch (value) {
		case 'allow':
		case 'session':
		case 'persist':
		case 'autoRun':
		case 'deny':
		case 'persistDeny':
			return value;
		default:
			return 'deny';
	}
}

function normalizeSingleSelectAnswer(raw: unknown): string | undefined {
	if (typeof raw === 'string' && raw.trim()) {
		return raw.trim();
	}
	if (raw && typeof raw === 'object') {
		const obj = raw as { selectedValue?: unknown; freeformValue?: unknown; value?: unknown };
		if (typeof obj.selectedValue === 'string' && obj.selectedValue.trim()) {
			return obj.selectedValue.trim();
		}
		if (typeof obj.value === 'string' && obj.value.trim()) {
			return obj.value.trim();
		}
		if (typeof obj.freeformValue === 'string' && obj.freeformValue.trim()) {
			return obj.freeformValue.trim();
		}
	}
	return undefined;
}

function truncate(s: string, n: number): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? t.slice(0, n) + '…' : t;
}
