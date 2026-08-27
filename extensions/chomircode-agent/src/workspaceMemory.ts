/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

const CACHE_REL = path.join('.panda', 'memory', 'workspace-memory-cache.md');
const INDEX_REL = path.join('.panda', 'MEMORY.md');
const META_REL = path.join('.panda', 'sessions-meta.json');

export type WorkspaceMemoryPreview = {
	readonly text: string;
	readonly fromCache: boolean;
	readonly sessionCount: number;
};

function readTextFile(abs: string): string {
	try {
		return fs.readFileSync(abs, 'utf8').trim();
	} catch {
		return '';
	}
}

/** Sync preview for Chat UI (engine injects full rollup via sidecar loadForPrompt). */
export function loadWorkspaceMemoryPreview(
	workspaceRoot: string,
	excludeSessionId?: string,
): WorkspaceMemoryPreview | undefined {
	const cache = readTextFile(path.join(workspaceRoot, CACHE_REL));
	if (cache) {
		return { text: cache, fromCache: true, sessionCount: countSessions(workspaceRoot, excludeSessionId) };
	}

	const index = readTextFile(path.join(workspaceRoot, INDEX_REL));
	const metaRaw = readTextFile(path.join(workspaceRoot, META_REL));
	if (!index && !metaRaw) {
		return undefined;
	}

	const lines: string[] = [];
	if (index) {
		lines.push('### MEMORY 索引', '', index.slice(0, 2200));
	}

	const sessions = parseSessionMeta(metaRaw, excludeSessionId).slice(0, 12);
	if (sessions.length) {
		lines.push('', '### 历史会话摘要', '');
		for (const s of sessions) {
			lines.push(`- **${s.title}** (\`${s.id}\`, ${s.updated})`);
			if (s.last) {
				lines.push(`  ${s.last.slice(0, 180)}`);
			}
		}
		if (parseSessionMeta(metaRaw, excludeSessionId).length > sessions.length) {
			lines.push(`- …另有 ${parseSessionMeta(metaRaw, excludeSessionId).length - sessions.length} 个会话（引擎侧已压缩注入）`);
		}
	}

	const text = lines.join('\n').trim();
	if (!text) {
		return undefined;
	}
	return { text: text.slice(0, 5500), fromCache: false, sessionCount: sessions.length };
}

function parseSessionMeta(
	raw: string,
	excludeSessionId?: string,
): Array<{ id: string; title: string; last: string; updated: string }> {
	if (!raw) {
		return [];
	}
	try {
		const map = JSON.parse(raw) as Record<string, { id?: string; title?: string; lastMessage?: string; updatedAt?: string }>;
		return Object.values(map)
			.map(s => ({
				id: String(s.id || ''),
				title: String(s.title || s.id || 'session').slice(0, 80),
				last: String(s.lastMessage || '').replace(/\s+/g, ' ').trim(),
				updated: String(s.updatedAt || '').slice(0, 10),
			}))
			.filter(s => s.id && s.id !== excludeSessionId)
			.sort((a, b) => b.updated.localeCompare(a.updated));
	} catch {
		return [];
	}
}

function countSessions(workspaceRoot: string, excludeSessionId?: string): number {
	return parseSessionMeta(readTextFile(path.join(workspaceRoot, META_REL)), excludeSessionId).length;
}

export function formatWorkspaceMemoryMarkdown(preview: WorkspaceMemoryPreview): string {
	const note = preview.fromCache
		? '_工作区长期记忆（已压缩缓存，新 Chat 自动注入引擎）_'
		: '_工作区长期记忆（MEMORY + 历史会话摘要，引擎每轮也会注入）_';
	return [
		'<details><summary>Workspace memory (auto-injected)</summary>',
		'',
		note,
		'',
		preview.text,
		'',
		'</details>',
		'',
	].join('\n');
}
