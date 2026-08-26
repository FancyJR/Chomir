/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { resolveEngineRoot } from './engineBridge';

export type SidecarHandle = {
	readonly baseUrl: string;
	readonly port: number;
	readonly engineRoot: string;
	readonly workspaceRoot: string;
	readonly compactKey: string;
	dispose(): void;
};

let active: SidecarHandle | undefined;
let starting: Promise<SidecarHandle> | undefined;

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			server.close((err) => (err ? reject(err) : resolve(port)));
		});
		server.on('error', reject);
	});
}

async function waitHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let lastErr = '';
	while (Date.now() - start < timeoutMs) {
		try {
			const ok = await new Promise<boolean>((resolve) => {
				const req = http.get(`${baseUrl}/api/health`, (res) => {
					res.resume();
					resolve(res.statusCode === 200);
				});
				req.on('error', () => resolve(false));
				req.setTimeout(1500, () => {
					req.destroy();
					resolve(false);
				});
			});
			if (ok) {
				return;
			}
		} catch (e) {
			lastErr = e instanceof Error ? e.message : String(e);
		}
		await new Promise(r => setTimeout(r, 250));
	}
	throw new Error(`ChomirCode sidecar health check failed: ${lastErr || 'timeout'}`);
}

/**
 * Ensure a long-lived ChomirCode Express sidecar for the workspace (full panda control plane).
 */
export async function ensureSidecar(options: {
	readonly enginePath?: string;
	readonly workspaceRoot: string;
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly contextWindow?: number;
	readonly compactOutputReserve?: number;
	readonly autocompactBuffer?: number;
}): Promise<SidecarHandle> {
	const engineRoot = resolveEngineRoot(options.enginePath);
	if (!engineRoot) {
		throw new Error('ChomirCode engine not found (set chomircode.enginePath)');
	}

	const compactKey = [
		options.contextWindow ?? 128000,
		options.compactOutputReserve ?? 8192,
		options.autocompactBuffer ?? 16000,
	].join(':');

	if (
		active
		&& active.engineRoot === engineRoot
		&& active.workspaceRoot === options.workspaceRoot
		&& active.compactKey === compactKey
	) {
		try {
			await waitHealthy(active.baseUrl, 2000);
			return active;
		} catch {
			active.dispose();
			active = undefined;
		}
	}

	if (starting) {
		return starting;
	}

	starting = (async () => {
		if (active) {
			active.dispose();
			active = undefined;
		}

		const port = await getFreePort();
		const serverEntry = path.join(engineRoot, 'server', 'index.js');
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PORT: String(port),
			HOST: '127.0.0.1',
			PANDA_PROJECT_ROOT: options.workspaceRoot,
			CHOMIRCODE_ENV_PATH: path.join(engineRoot, '.env.local'),
			CHOMIRCODE_DESKTOP: '1', // skip SIGINT handlers that fight the extension host
			// Compat aliases for older engine builds
			AIFRONT_ENV_PATH: path.join(engineRoot, '.env.local'),
			AIFRONT_DESKTOP: '1',
			// Cursor-like context window + autocompact (panda compact.js)
			CLAW_CONTEXT_WINDOW: String(options.contextWindow ?? 128000),
			CLAW_COMPACT_OUTPUT_RESERVE: String(options.compactOutputReserve ?? 8192),
			CLAW_AUTOCOMPACT_BUFFER: String(options.autocompactBuffer ?? 16000),
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

		const child = cp.spawn(process.execPath, [serverEntry], {
			cwd: engineRoot,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: false,
		});

		let stderrTail = '';
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-4000);
		});
		child.stdout?.resume();

		const baseUrl = `http://127.0.0.1:${port}`;
		try {
			await waitHealthy(baseUrl, 45000);
		} catch (e) {
			try {
				child.kill('SIGTERM');
			} catch {
				// ignore
			}
			const detail = e instanceof Error ? e.message : String(e);
			throw new Error(`${detail}${stderrTail ? `\n${stderrTail}` : ''}`);
		}

		const handle: SidecarHandle = {
			baseUrl,
			port,
			engineRoot,
			workspaceRoot: options.workspaceRoot,
			compactKey,
			dispose: () => {
				try {
					child.kill('SIGTERM');
				} catch {
					// ignore
				}
				if (active === handle) {
					active = undefined;
				}
			},
		};
		child.on('exit', () => {
			if (active === handle) {
				active = undefined;
			}
		});
		active = handle;
		return handle;
	})();

	try {
		return await starting;
	} finally {
		starting = undefined;
	}
}

export function disposeSidecar(): void {
	active?.dispose();
	active = undefined;
}

export function getActiveSidecar(): SidecarHandle | undefined {
	return active;
}
