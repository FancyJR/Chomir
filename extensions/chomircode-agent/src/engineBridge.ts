/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface EngineRunOptions {
	readonly cwd: string;
	readonly task: string;
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly activeFile?: string;
	readonly permissionMode?: string;
	readonly maxRounds?: number;
	readonly engineRoot: string;
	readonly token: { readonly isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose(): void } };
	readonly onEvent: (event: string, data: unknown) => void;
}

export interface EngineRunResult {
	readonly ok: boolean;
	readonly aborted?: boolean;
	readonly finalAnswer?: string;
	readonly sessionId?: string;
	readonly changed?: string[];
	readonly error?: string;
	readonly exitCode: number;
}

/**
 * Resolve ChomirCode repo root that contains bin/chomircode-agent.js.
 */
export function resolveEngineRoot(configured: string | undefined): string | undefined {
	const candidates: string[] = [];
	if (configured && configured.trim()) {
		candidates.push(path.resolve(configured.trim()));
	}
	if (process.env.CHOMIRCODE_ROOT) {
		candidates.push(path.resolve(process.env.CHOMIRCODE_ROOT));
	}
	if (process.env.SHIYUNCODE_ROOT) {
		candidates.push(path.resolve(process.env.SHIYUNCODE_ROOT));
	}
	if (process.env.AIFRONT_ROOT) {
		candidates.push(path.resolve(process.env.AIFRONT_ROOT));
	}
	// vscode checkout: <repo>/extensions/chomircode-agent → sibling AIFront under same parent
	// extension runs from extensions/chomircode-agent/out → walk up to workspace root
	const fromExtension = path.resolve(__dirname, '..', '..', '..', 'AIFront');
	candidates.push(fromExtension);
	// Packaged app: Resources/app/extensions/chomircode-agent/out → Resources/app/AIFront
	const fromPackagedApp = path.resolve(__dirname, '..', '..', '..', 'AIFront');
	if (fromPackagedApp !== fromExtension) {
		candidates.push(fromPackagedApp);
	}
	// Also try next to the extension folder itself (same layout as packaged)
	candidates.push(path.resolve(__dirname, '..', '..', 'AIFront'));
	const fromCwd = path.resolve(process.cwd(), 'AIFront');
	candidates.push(fromCwd);
	const siblingOfCwd = path.resolve(process.cwd(), '..', 'AIFront');
	candidates.push(siblingOfCwd);

	for (const root of candidates) {
		const cli = path.join(root, 'bin', 'chomircode-agent.js');
		const legacyCli = path.join(root, 'bin', 'shiyuncode-agent.js');
		const designCli = path.join(root, 'bin', 'shiyundesign-agent.js');
		if (fs.existsSync(cli) || fs.existsSync(legacyCli) || fs.existsSync(designCli)) {
			return root;
		}
	}
	return undefined;
}

export function getAgentCliPath(engineRoot: string): string {
	const preferred = path.join(engineRoot, 'bin', 'chomircode-agent.js');
	if (fs.existsSync(preferred)) {
		return preferred;
	}
	return path.join(engineRoot, 'bin', 'shiyuncode-agent.js');
}

/**
 * Spawn ChomirCode headless agent. Final result is one JSON line on stdout.
 * With --events-jsonl, progress events are JSON lines on stderr prefixed with "CHOMIRCODE_EVENT ".
 */
export function runChomircodeAgent(options: EngineRunOptions): Promise<EngineRunResult> {
	const cli = getAgentCliPath(options.engineRoot);
	if (!fs.existsSync(cli)) {
		return Promise.resolve({
			ok: false,
			error: `ChomirCode CLI not found: ${cli}`,
			exitCode: 2,
		});
	}

	const args = [
		cli,
		'--cwd', options.cwd,
		'--task', options.task,
		'--events-jsonl',
		'--permission-mode', options.permissionMode || 'bypassPermissions',
		'--max-rounds', String(options.maxRounds ?? 40),
	];
	if (options.model) {
		args.push('--model', options.model);
	}
	if (options.activeFile) {
		args.push('--active-file', options.activeFile);
	}

	const env: NodeJS.ProcessEnv = {
		...process.env,
	};
	if (options.apiKey) {
		env.DEEPSEEK_API_KEY = options.apiKey;
	}
	if (options.baseUrl) {
		env.DEEPSEEK_BASE_URL = options.baseUrl.replace(/\/$/, '');
	}
	if (options.model) {
		env.DEEPSEEK_MODEL = options.model;
	}

	return new Promise<EngineRunResult>((resolve) => {
		const child = cp.spawn(process.execPath, args, {
			cwd: options.engineRoot,
			env,
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
			// Forward short diagnostic lines as system status
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
					error: stdoutBuf.trim() || `ChomirCode agent exited with code ${exitCode}`,
					exitCode,
				});
				return;
			}

			finish(result);
		});
	});
}
