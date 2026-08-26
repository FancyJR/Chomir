/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export type PandaEventHandler = (event: string, data: Record<string, unknown>) => void | Promise<void>;

export type ExecuteOptions = {
	readonly baseUrl: string;
	readonly message: string;
	readonly projectRoot: string;
	readonly sessionId: string;
	readonly model?: string;
	readonly permissionMode?: string;
	readonly maxRounds?: number;
	readonly activeFile?: string;
	readonly history?: Array<{ role: string; content: string }>;
	readonly token: { readonly isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose(): void } };
	readonly onEvent: PandaEventHandler;
};

export type ExecuteResult = {
	readonly ok: boolean;
	readonly aborted?: boolean;
	readonly sessionId: string;
	readonly changed: string[];
	readonly error?: string;
	readonly finalAnswer?: string;
};

function requestJson(baseUrl: string, method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: any }> {
	const url = new URL(apiPath, baseUrl);
	const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
	const lib = url.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		const req = lib.request({
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			path: url.pathname + url.search,
			method,
			headers: {
				'Content-Type': 'application/json',
				...(payload ? { 'Content-Length': String(payload.length) } : {}),
			},
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				let json: any = {};
				try {
					json = text ? JSON.parse(text) : {};
				} catch {
					json = { raw: text };
				}
				resolve({ status: res.statusCode || 0, json });
			});
		});
		req.on('error', reject);
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

export async function pandaAbort(baseUrl: string, sessionId: string): Promise<boolean> {
	const { json } = await requestJson(baseUrl, 'POST', '/api/panda/abort', { sessionId });
	return !!(json && (json.ok || json.aborted));
}

export async function pandaSteer(baseUrl: string, sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
	const { status, json } = await requestJson(baseUrl, 'POST', '/api/panda/steer', { sessionId, text });
	if (status >= 200 && status < 300 && json?.ok) {
		return { ok: true };
	}
	return { ok: false, error: json?.error || `steer failed (${status})` };
}

export async function pandaResolvePermission(baseUrl: string, body: Record<string, unknown>): Promise<boolean> {
	const { json } = await requestJson(baseUrl, 'POST', '/api/panda/permission', body);
	return !!(json && (json.ok || json.resolved));
}

export async function pandaResolveTeamPermission(baseUrl: string, body: Record<string, unknown>): Promise<boolean> {
	const { json } = await requestJson(baseUrl, 'POST', '/api/panda/team/permission', body);
	return !!(json && json.ok);
}

export async function pandaSetRuntime(baseUrl: string, body: Record<string, unknown>): Promise<boolean> {
	const { json } = await requestJson(baseUrl, 'POST', '/api/panda/runtime', body);
	return !!(json && json.ok !== false);
}

export async function pandaListSlashCommands(baseUrl: string): Promise<Array<{ name: string; description?: string }>> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/slash-commands');
	const list = Array.isArray(json) ? json : (json?.commands || json?.items || []);
	return (list as any[]).map((c) => ({
		name: String(c.name || c.command || c.id || ''),
		description: c.description ? String(c.description) : undefined,
	})).filter(c => c.name);
}

export async function pandaListSessions(baseUrl: string): Promise<any[]> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/sessions');
	return Array.isArray(json) ? json : (json?.sessions || []);
}

export async function pandaGetMcp(baseUrl: string): Promise<any> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/mcp');
	return json;
}

export async function pandaConnectMcp(baseUrl: string, serverName?: string): Promise<any> {
	const { json } = await requestJson(baseUrl, 'POST', '/api/panda/mcp/connect', serverName ? { name: serverName } : {});
	return json;
}

export async function pandaGetUsage(baseUrl: string): Promise<any> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/usage');
	return json;
}

export async function pandaGetWorktree(baseUrl: string): Promise<any> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/worktree');
	return json;
}

export async function pandaGetCron(baseUrl: string): Promise<any> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/cron');
	return json;
}

export async function pandaGetTasks(baseUrl: string): Promise<any> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/tasks');
	return json;
}

export async function pandaGetSwarms(baseUrl: string): Promise<any> {
	const { json } = await requestJson(baseUrl, 'GET', '/api/panda/swarms');
	return json;
}

export async function pandaIsRunLive(baseUrl: string, sessionId: string): Promise<boolean> {
	const { status, json } = await requestJson(baseUrl, 'GET', `/api/panda/runs/${encodeURIComponent(sessionId)}`);
	if (status !== 200) {
		return false;
	}
	return !!(json?.running || json?.alive || json?.status === 'running');
}

/**
 * Run panda agent via SSE `/api/engine/execute` (full control plane).
 */
export function executePandaSse(options: ExecuteOptions): Promise<ExecuteResult> {
	const url = new URL('/api/engine/execute', options.baseUrl);
	const body = Buffer.from(JSON.stringify({
		message: options.message,
		stream: true,
		projectRoot: options.projectRoot,
		context: {
			agentMode: 'panda',
			model: options.model || '',
			activeFile: options.activeFile || '',
			preferredFile: options.activeFile || '',
			sessionId: options.sessionId,
			projectRoot: options.projectRoot,
			cwd: options.projectRoot,
			history: options.history || [],
			permissionMode: options.permissionMode || 'acceptEdits',
			maxRounds: options.maxRounds,
			autoApprove: options.permissionMode === 'bypassPermissions'
				? 'all'
				: options.permissionMode === 'acceptEdits',
		},
	}), 'utf8');

	return new Promise((resolve) => {
		let settled = false;
		let sessionId = options.sessionId;
		const changed = new Set<string>();
		let finalAnswer = '';
		let error = '';
		let aborted = false;
		let buffer = '';

		const finish = (result: ExecuteResult) => {
			if (settled) {
				return;
			}
			settled = true;
			cancelSub.dispose();
			resolve(result);
		};

		const req = http.request({
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			path: url.pathname,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': String(body.length),
				Accept: 'text/event-stream',
			},
		}, (res) => {
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => {
				buffer += chunk;
				const parts = buffer.split(/\n/);
				buffer = parts.pop() || '';
				for (const line of parts) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) {
						continue;
					}
					const raw = trimmed.slice(5).trim();
					if (!raw || raw === '[DONE]') {
						continue;
					}
					try {
						const payload = JSON.parse(raw) as Record<string, unknown>;
						const event = String(payload.event || '');
						const data = { ...payload };
						delete data.event;

						if (typeof data.sessionId === 'string' && data.sessionId) {
							sessionId = data.sessionId;
						}
						if (event === 'kind' && typeof data.sessionId === 'string') {
							sessionId = data.sessionId;
						}
						if (event === 'done' || event === 'changed') {
							const files = (data.changed || data.files) as any;
							if (Array.isArray(files)) {
								for (const f of files) {
									const name = typeof f === 'string' ? f : f?.file;
									if (name) {
										changed.add(String(name));
									}
								}
							}
						}
						if (event === 'panda_stream' && data.kind !== 'thinking') {
							const chunk = String(data.chunk ?? data.delta ?? data.text ?? '');
							if (chunk) {
								finalAnswer += chunk;
							}
						}
						if (event === 'panda_stream_end' && data.kind !== 'thinking' && typeof data.content === 'string' && data.content) {
							if (!finalAnswer) {
								finalAnswer = data.content;
							}
						}
						if (event === 'panda_block' && data.type === 'assistant_text' && typeof data.content === 'string' && data.content && !data.streaming) {
							finalAnswer = data.content;
						}
						if (event === 'error' && typeof data.message === 'string') {
							error = data.message;
						}
						if (event === 'done' && data.aborted) {
							aborted = true;
						}

						void Promise.resolve(options.onEvent(event, data as Record<string, unknown>)).catch(() => { /* ignore */ });
					} catch {
						// ignore malformed SSE
					}
				}
			});
			res.on('end', () => {
				if (options.token.isCancellationRequested || aborted) {
					finish({ ok: false, aborted: true, sessionId, changed: [...changed], finalAnswer });
					return;
				}
				if (error) {
					finish({ ok: false, sessionId, changed: [...changed], error, finalAnswer });
					return;
				}
				finish({ ok: true, sessionId, changed: [...changed], finalAnswer });
			});
		});

		const cancelSub = options.token.onCancellationRequested(() => {
			aborted = true;
			void pandaAbort(options.baseUrl, sessionId);
			try {
				req.destroy();
			} catch {
				// ignore
			}
		});

		req.on('error', (err) => {
			finish({
				ok: false,
				aborted: options.token.isCancellationRequested,
				sessionId,
				changed: [...changed],
				error: err.message || String(err),
			});
		});

		req.write(body);
		req.end();
	});
}
