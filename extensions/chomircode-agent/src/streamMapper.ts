/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

/**
 * Map panda engine events to Chat markdown progress.
 */
export class StreamMapper {
	private lastStatus = '';
	private streamedAssistant = false;

	constructor(private readonly stream: vscode.ChatResponseStream) { }

	handle(event: string, data: unknown): void {
		const d = (data && typeof data === 'object') ? data as Record<string, unknown> : {};

		switch (event) {
			case 'panda_stream': {
				// Engine: { kind: 'text'|'thinking', chunk }
				const kind = typeof d.kind === 'string' ? d.kind : 'text';
				const delta = typeof d.chunk === 'string' ? d.chunk
					: typeof d.delta === 'string' ? d.delta
						: typeof d.text === 'string' ? d.text
							: typeof d.content === 'string' ? d.content
								: '';
				if (delta && kind !== 'thinking') {
					this.stream.markdown(delta);
					this.streamedAssistant = true;
				}
				break;
			}
			case 'panda_stream_end': {
				const kind = typeof d.kind === 'string' ? d.kind : 'text';
				const content = typeof d.content === 'string' ? d.content : '';
				if (kind === 'text' && content && !this.streamedAssistant) {
					this.stream.markdown(content);
					this.streamedAssistant = true;
				}
				break;
			}
			case 'panda_block': {
				const type = typeof d.type === 'string' ? d.type : '';
				const content = typeof d.content === 'string' ? d.content : '';
				if (!content) {
					break;
				}
				if (type === 'assistant_text') {
					if (!this.streamedAssistant) {
						this.stream.markdown(content);
						this.streamedAssistant = true;
					} else {
						// Prefer stream deltas; avoid duplicating full blocks when streaming already happened
						this.stream.markdown('\n\n' + content);
					}
				} else if (type === 'tool_call' || type === 'tool') {
					const name = typeof d.name === 'string' ? d.name : (typeof d.tool === 'string' ? d.tool : 'tool');
					this.stream.markdown(`\n\n- **Tool** \`${name}\`${content ? `: ${truncate(content, 240)}` : ''}\n`);
				} else if (type === 'system') {
					this.stream.markdown(`\n\n_${escapeMd(truncate(content, 300))}_\n`);
				}
				break;
			}
			case 'panda_status': {
				const msg = typeof d.message === 'string' ? d.message
					: typeof d.status === 'string' ? d.status
						: typeof d.text === 'string' ? d.text
							: '';
				if (msg && msg !== this.lastStatus) {
					this.lastStatus = msg;
					this.stream.markdown(`\n\n_${escapeMd(truncate(msg, 200))}_\n`);
				}
				break;
			}
			case 'panda_tool_start': {
				const name = typeof d.name === 'string' ? d.name : 'tool';
				this.stream.markdown(`\n\n- Running \`${name}\`…\n`);
				break;
			}
			case 'panda_tool_end': {
				const name = typeof d.name === 'string' ? d.name : 'tool';
				const ok = d.ok !== false;
				this.stream.markdown(`\n- \`${name}\` ${ok ? 'done' : 'failed'}\n`);
				break;
			}
			case 'panda_diag': {
				// Quiet: ignore verbose diag unless useful later
				break;
			}
			default:
				break;
		}
	}
}

function truncate(s: string, n: number): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function escapeMd(s: string): string {
	return s.replace(/([\\`*_[\]{}()#+-.!])/g, '\\$1');
}
