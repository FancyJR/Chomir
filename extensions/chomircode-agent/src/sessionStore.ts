/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const BRIDGE_FILE = 'vscode-bridge.json';
const HISTORY_DIR = 'chat-history';

export type BridgeState = {
	/** Active panda session for the next Chat turn when UI history is empty / resumed. */
	activeSessionId?: string;
	/** If set, empty Chat history should reuse this session (Resume) instead of creating new. */
	resumeSessionId?: string;
	/** Map: fingerprint of first user prompt → sessionId */
	byFirstPrompt?: Record<string, string>;
	updatedAt?: string;
};

function pandaRoot(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.panda');
}

function bridgePath(workspaceRoot: string): string {
	return path.join(pandaRoot(workspaceRoot), BRIDGE_FILE);
}

export function readBridge(workspaceRoot: string): BridgeState {
	try {
		const raw = fs.readFileSync(bridgePath(workspaceRoot), 'utf8');
		const data = JSON.parse(raw);
		return data && typeof data === 'object' ? data as BridgeState : {};
	} catch {
		return {};
	}
}

export function writeBridge(workspaceRoot: string, state: BridgeState): void {
	const root = pandaRoot(workspaceRoot);
	fs.mkdirSync(root, { recursive: true });
	const next: BridgeState = {
		...readBridge(workspaceRoot),
		...state,
		updatedAt: new Date().toISOString(),
	};
	fs.writeFileSync(bridgePath(workspaceRoot), JSON.stringify(next, null, 2), 'utf8');
}

export function fingerprintPrompt(prompt: string): string {
	const t = (prompt || '').trim().slice(0, 120).toLowerCase().replace(/\s+/g, ' ');
	return t;
}

/**
 * Resolve panda session id with persistence across restarts.
 * - Explicit history metadata sessionId wins
 * - Empty Chat + resume latch (from Sessions UI / post-startup continue) → that session
 * - Empty Chat otherwise → always a NEW session (so workbench "New Chat" is not a no-op)
 * - Non-empty history → first-prompt map / activeSessionId
 * - Else → new session
 */
export function resolvePersistedSessionId(options: {
	workspaceRoot: string;
	historyEmpty: boolean;
	historySessionId?: string;
	firstPrompt?: string;
	/** @deprecated Empty-history continue now uses resume latch only; kept for callers. */
	continueLast?: boolean;
	forceNew?: boolean;
}): { sessionId: string; isNew: boolean; resumed: boolean } {
	const bridge = readBridge(options.workspaceRoot);

	if (options.forceNew) {
		const id = `sess_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
		writeBridge(options.workspaceRoot, {
			activeSessionId: id,
			resumeSessionId: undefined,
		});
		return { sessionId: id, isNew: true, resumed: false };
	}

	if (options.historySessionId) {
		writeBridge(options.workspaceRoot, {
			activeSessionId: options.historySessionId,
			resumeSessionId: undefined,
		});
		return { sessionId: options.historySessionId, isNew: false, resumed: false };
	}

	if (options.historyEmpty) {
		if (bridge.resumeSessionId) {
			const id = bridge.resumeSessionId;
			writeBridge(options.workspaceRoot, {
				activeSessionId: id,
				resumeSessionId: undefined, // one-shot resume latch
			});
			return { sessionId: id, isNew: false, resumed: true };
		}
		// Do NOT auto-reuse activeSessionId here — that made workbench "New Chat"
		// look broken (UI cleared but agent kept the previous panda session).
		const id = `sess_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
		writeBridge(options.workspaceRoot, { activeSessionId: id, resumeSessionId: undefined });
		return { sessionId: id, isNew: true, resumed: false };
	}

	const fp = fingerprintPrompt(options.firstPrompt || '');
	if (fp && bridge.byFirstPrompt?.[fp]) {
		const id = bridge.byFirstPrompt[fp];
		writeBridge(options.workspaceRoot, { activeSessionId: id });
		return { sessionId: id, isNew: false, resumed: false };
	}

	if (bridge.activeSessionId) {
		return { sessionId: bridge.activeSessionId, isNew: false, resumed: false };
	}

	const id = `sess_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
	writeBridge(options.workspaceRoot, { activeSessionId: id });
	return { sessionId: id, isNew: true, resumed: false };
}

/** Clear resume latch and start a fresh panda session id on next turn. */
export function clearSessionForNewChat(workspaceRoot: string): string {
	const id = `sess_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
	writeBridge(workspaceRoot, {
		activeSessionId: id,
		resumeSessionId: undefined,
	});
	return id;
}

export function rememberSession(workspaceRoot: string, sessionId: string, firstPrompt?: string): void {
	const bridge = readBridge(workspaceRoot);
	const byFirstPrompt = { ...(bridge.byFirstPrompt || {}) };
	const fp = fingerprintPrompt(firstPrompt || '');
	if (fp) {
		byFirstPrompt[fp] = sessionId;
	}
	// Cap map size
	const keys = Object.keys(byFirstPrompt);
	if (keys.length > 200) {
		for (const k of keys.slice(0, keys.length - 200)) {
			delete byFirstPrompt[k];
		}
	}
	writeBridge(workspaceRoot, {
		activeSessionId: sessionId,
		byFirstPrompt,
	});
}

export function setResumeSession(workspaceRoot: string, sessionId: string): void {
	writeBridge(workspaceRoot, {
		activeSessionId: sessionId,
		resumeSessionId: sessionId,
	});
}

export function appendLocalChatHistory(
	workspaceRoot: string,
	sessionId: string,
	turn: { role: 'user' | 'assistant' | 'system'; content: string },
): void {
	const dir = path.join(pandaRoot(workspaceRoot), HISTORY_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sessionId}.md`);
	const stamp = new Date().toISOString();
	const block = `\n### ${turn.role} · ${stamp}\n\n${turn.content}\n`;
	fs.appendFileSync(file, block, 'utf8');
}

export function readLocalChatHistory(workspaceRoot: string, sessionId: string): string {
	const file = path.join(pandaRoot(workspaceRoot), HISTORY_DIR, `${sessionId}.md`);
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

export function listLocalSessionFiles(workspaceRoot: string): Array<{ id: string; title: string; updatedAt: number }> {
	const metaPath = path.join(pandaRoot(workspaceRoot), 'sessions-meta.json');
	try {
		const map = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, any>;
		return Object.values(map)
			.map((s) => ({
				id: String(s.id || ''),
				title: String(s.title || s.lastMessage || s.id || 'session'),
				updatedAt: Date.parse(s.updatedAt || s.createdAt || 0) || 0,
			}))
			.filter(s => s.id)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	} catch {
		return [];
	}
}

export function readTranscriptPreview(workspaceRoot: string, sessionId: string, maxLines = 80): string {
	const turns = loadTranscriptTurns(workspaceRoot, sessionId, maxLines);
	if (!turns.length) {
		return readLocalChatHistory(workspaceRoot, sessionId) || `_No transcript for ${sessionId}_`;
	}
	const parts: string[] = [`# Session \`${sessionId}\``, ''];
	for (const t of turns) {
		parts.push(`## ${t.role}`);
		parts.push(t.content.slice(0, 4000));
		parts.push('');
	}
	return parts.join('\n');
}

/** Load user/assistant turns from panda jsonl + local chat-history mirror. */
export function loadTranscriptTurns(
	workspaceRoot: string,
	sessionId: string,
	maxTurns = 40,
): Array<{ role: 'user' | 'assistant'; content: string }> {
	const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	const file = path.join(pandaRoot(workspaceRoot), 'sessions', `${sessionId}.jsonl`);
	try {
		const lines = fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean).slice(-Math.max(maxTurns * 3, 80));
		for (const line of lines) {
			try {
				const e = JSON.parse(line);
				const role = String(e.role || e.type || '').toLowerCase();
				const content = String(e.content || e.text || '').trim();
				if (!content) {
					continue;
				}
				if (role === 'user' || role === 'human') {
					turns.push({ role: 'user', content: content.slice(0, 8000) });
				} else if (role === 'assistant' || role === 'ai' || role === 'model') {
					turns.push({ role: 'assistant', content: content.slice(0, 8000) });
				}
			} catch {
				// skip
			}
		}
	} catch {
		// no jsonl
	}

	if (!turns.length) {
		const md = readLocalChatHistory(workspaceRoot, sessionId);
		const blocks = md.split(/\n### /).filter(Boolean);
		for (const block of blocks) {
			const m = /^(user|assistant|system)\s*·[^\n]*\n([\s\S]*)$/i.exec(block.trim());
			if (!m) {
				continue;
			}
			const role = m[1].toLowerCase();
			const content = m[2].trim();
			if (!content) {
				continue;
			}
			if (role === 'user' || role === 'assistant') {
				turns.push({ role: role as 'user' | 'assistant', content: content.slice(0, 8000) });
			}
		}
	}

	return turns.slice(-maxTurns);
}

/** Format prior turns for Chat UI when VS Code history was empty after reopen. */
export function formatHistoryReplayMarkdown(turns: Array<{ role: 'user' | 'assistant'; content: string }>): string {
	if (!turns.length) {
		return '';
	}
	const parts: string[] = ['<details><summary>Previous conversation (restored)</summary>\n'];
	for (const t of turns) {
		const label = t.role === 'user' ? 'You' : 'ChomirCode';
		parts.push(`\n**${label}**\n\n${t.content.slice(0, 3000)}\n`);
	}
	parts.push('\n</details>\n\n');
	return parts.join('');
}

/** WorkspaceState helpers (also survive when .panda is gitignored but state remains). */
const WS_KEY = 'chomircode.bridge';
const WS_KEY_LEGACY = 'aifront.bridge';

export function syncBridgeToWorkspaceState(context: vscode.ExtensionContext, workspaceRoot: string): void {
	const bridge = readBridge(workspaceRoot);
	void context.workspaceState.update(WS_KEY, bridge);
	void context.workspaceState.update(WS_KEY_LEGACY, undefined);
}

export function hydrateBridgeFromWorkspaceState(context: vscode.ExtensionContext, workspaceRoot: string): void {
	const saved = context.workspaceState.get<BridgeState>(WS_KEY)
		?? context.workspaceState.get<BridgeState>(WS_KEY_LEGACY);
	if (!saved) {
		return;
	}
	const disk = readBridge(workspaceRoot);
	if (!disk.activeSessionId && saved.activeSessionId) {
		writeBridge(workspaceRoot, { ...saved, ...disk });
	}
}
