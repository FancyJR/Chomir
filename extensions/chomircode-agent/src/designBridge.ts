/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { EngineRunResult } from './engineBridge';

export interface DesignRunOptions {
	readonly cwd: string;
	readonly task: string;
	readonly engineRoot: string;
	readonly permissionMode?: string;
	readonly maxRounds?: number;
	readonly token: { readonly isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose(): void } };
	readonly onEvent: (event: string, data: unknown) => void;
}

export function getShiyundesignCliPath(engineRoot: string): string {
	return path.join(engineRoot, 'bin', 'shiyundesign-agent.js');
}

/**
 * Spawn ShiyunDesign headless agent (OpenDesign assets + ChomirCode executor).
 * Final result is one JSON line on stdout; ChomirCode progress may appear on stderr.
 */
export function runShiyundesignAgent(options: DesignRunOptions): Promise<EngineRunResult> {
	const cli = getShiyundesignCliPath(options.engineRoot);
	if (!fs.existsSync(cli)) {
		return Promise.resolve({
			ok: false,
			error: `ShiyunDesign CLI not found: ${cli}`,
			exitCode: 2,
		});
	}

	fs.mkdirSync(options.cwd, { recursive: true });

	const args = [
		cli,
		'--cwd', options.cwd,
		'--task', options.task,
		'--permission-mode', options.permissionMode || 'bypassPermissions',
		'--max-rounds', String(options.maxRounds ?? 80),
	];

	return new Promise<EngineRunResult>((resolve) => {
		const child = cp.spawn(process.execPath, args, {
			cwd: options.engineRoot,
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdoutBuf = '';
		let settled = false;
		const finish = (result: EngineRunResult) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(result);
		};

		const cancelSub = options.token.onCancellationRequested(() => {
			try {
				child.kill('SIGTERM');
			} catch {
				// ignore
			}
		});

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdoutBuf += chunk;
		});

		const stderrRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
		stderrRl.on('line', (line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith('CHOMIRCODE_EVENT ') || trimmed.startsWith('SHIYUNCODE_EVENT ') || trimmed.startsWith('AIFRONT_EVENT ')) {
				const payload = trimmed.startsWith('CHOMIRCODE_EVENT ')
					? trimmed.slice('CHOMIRCODE_EVENT '.length)
					: trimmed.startsWith('SHIYUNCODE_EVENT ')
						? trimmed.slice('SHIYUNCODE_EVENT '.length)
						: trimmed.slice('AIFRONT_EVENT '.length);
				try {
					const parsed = JSON.parse(payload) as { event?: string; data?: unknown };
					if (parsed && typeof parsed.event === 'string') {
						options.onEvent(parsed.event, parsed.data ?? {});
					}
				} catch {
					// ignore malformed event lines
				}
				return;
			}
			if (trimmed.startsWith('[chomircode-agent]')) {
				options.onEvent('panda_diag', { line: trimmed });
			}
		});

		child.on('error', (err) => {
			cancelSub.dispose();
			finish({
				ok: false,
				error: err.message || String(err),
				exitCode: 1,
			});
		});

		child.on('close', (code, signal) => {
			cancelSub.dispose();
			stderrRl.close();
			const exitCode = typeof code === 'number' ? code : (signal === 'SIGTERM' || signal === 'SIGINT' ? 130 : 1);

			const lines = stdoutBuf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
			let result: EngineRunResult | undefined;
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					const parsed = JSON.parse(lines[i]) as EngineRunResult & { ok?: boolean };
					if (parsed && typeof parsed === 'object' && ('ok' in parsed || 'finalAnswer' in parsed || 'error' in parsed)) {
						result = {
							ok: !!parsed.ok,
							aborted: parsed.aborted,
							finalAnswer: parsed.finalAnswer,
							sessionId: parsed.sessionId,
							changed: parsed.changed,
							error: parsed.error,
							exitCode,
						};
						break;
					}
				} catch {
					// keep scanning
				}
			}

			if (!result) {
				if (options.token.isCancellationRequested || exitCode === 130) {
					finish({ ok: false, aborted: true, finalAnswer: '已中断', exitCode: 130 });
					return;
				}
				finish({
					ok: false,
					error: stdoutBuf.trim() || `ShiyunDesign agent exited with code ${exitCode}`,
					exitCode,
				});
				return;
			}

			finish(result);
		});
	});
}

/** Pick primary HTML deliverable under prototype cwd. */
export function pickHtmlDeliverable(changed: readonly string[]): string | undefined {
	const html = changed.filter(f => /\.x?html?$/i.test(f));
	if (!html.length) {
		return undefined;
	}
	return html.find(f => /(^|\/)index\.x?html?$/i.test(f)) || html[0];
}

export function resolvePrototypeOutputDir(workspaceRoot: string, sessionId: string, prototypesDir: string): string {
	const base = (prototypesDir || 'prototypes').replace(/^\/+|\/+$/g, '') || 'prototypes';
	const slug = sessionId.replace(/^design_/, '').slice(0, 16) || Date.now().toString(16);
	return path.join(workspaceRoot, base, slug);
}
