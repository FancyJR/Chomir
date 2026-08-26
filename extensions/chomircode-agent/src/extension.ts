/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEEPSEEK_MODELS, DEEPSEEK_VENDOR, DeepSeekConfig, DeepSeekLanguageModelProvider, normalizeBaseUrl, OFFICIAL_BASE_URL } from './deepseekProvider';
import { resolveEngineRoot, runChomircodeAgent } from './engineBridge';
import { PandaEventMapper } from './eventMapper';
import {
	executePandaSse,
	pandaAbort,
	pandaConnectMcp,
	pandaGetCron,
	pandaGetMcp,
	pandaGetSwarms,
	pandaGetTasks,
	pandaGetUsage,
	pandaGetWorktree,
	pandaIsRunLive,
	pandaListSessions,
	pandaListSlashCommands,
	pandaSetRuntime,
} from './pandaClient';
import { disposeSidecar, ensureSidecar } from './sidecar';
import {
	appendLocalChatHistory,
	clearSessionForNewChat,
	formatHistoryReplayMarkdown,
	hydrateBridgeFromWorkspaceState,
	listLocalSessionFiles,
	loadTranscriptTurns,
	readBridge,
	readTranscriptPreview,
	rememberSession,
	resolvePersistedSessionId,
	setResumeSession,
	syncBridgeToWorkspaceState,
} from './sessionStore';
import { StreamMapper } from './streamMapper';

const PARTICIPANT_ID = 'chomircode.agent';
const MODEL_CHOICES = DEEPSEEK_MODELS.map(m => ({
	label: m.id,
	description: m.detail,
}));

export function activate(context: vscode.ExtensionContext): void {
	void migrateLegacyAifrontSettings(context);

	const provider = new DeepSeekLanguageModelProvider(async (config) => {
		await syncChomircodeSettings(config);
	});

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		hydrateBridgeFromWorkspaceState(context, folder.uri.fsPath);
		// One-shot: after IDE restart, empty Chat may resume last panda session once.
		// Workbench "New Chat" clears this latch via onWorkbenchNewChat.
		const cfg = vscode.workspace.getConfiguration('chomircode');
		if (cfg.get<boolean>('continueLastSession') !== false) {
			const bridge = readBridge(folder.uri.fsPath);
			if (bridge.activeSessionId && !bridge.resumeSessionId) {
				setResumeSession(folder.uri.fsPath, bridge.activeSessionId);
			}
		}
	}

	context.subscriptions.push(
		provider,
		{ dispose: () => disposeSidecar() },
		vscode.lm.registerLanguageModelChatProvider(DEEPSEEK_VENDOR, provider),
		vscode.commands.registerCommand('chomircode.agent.onWorkbenchNewChat', async () => {
			const ws = vscode.workspace.workspaceFolders?.[0];
			if (!ws) {
				return;
			}
			clearSessionForNewChat(ws.uri.fsPath);
			syncBridgeToWorkspaceState(context, ws.uri.fsPath);
		}),
		vscode.commands.registerCommand('chomircode.agent.openSettings', async () => {
			await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:chomircode.chomircode-agent');
		}),
		vscode.commands.registerCommand('chomircode.agent.setApiKey', async () => {
			await setApiKeyInteractive(provider);
		}),
		vscode.commands.registerCommand('chomircode.agent.selectModel', async () => {
			await selectModelInteractive();
		}),
		vscode.commands.registerCommand('chomircode.agent.showStatus', async () => {
			await showStatus();
		}),
		vscode.commands.registerCommand('chomircode.agent.manageModels', async () => {
			await setApiKeyInteractive(provider);
		}),
		vscode.commands.registerCommand('chomircode.agent.openPandaConfig', async () => {
			await openPandaFile('config.json', defaultConfigJson());
		}),
		vscode.commands.registerCommand('chomircode.agent.openMcpConfig', async () => {
			await openPandaFile('mcp.json', '{\n  "mcpServers": {}\n}\n');
		}),
		vscode.commands.registerCommand('chomircode.agent.openPermissions', async () => {
			await openPandaFile('permissions.json', '{\n  "allow": [],\n  "deny": [],\n  "ask": []\n}\n');
		}),
		vscode.commands.registerCommand('chomircode.agent.openHooks', async () => {
			await openPandaFile('hooks.json', '{\n  "hooks": {}\n}\n');
		}),
		vscode.commands.registerCommand('chomircode.agent.openSkills', async () => {
			await openPandaDir('skills');
		}),
		vscode.commands.registerCommand('chomircode.agent.openMemory', async () => {
			await openPandaFile('MEMORY.md', '# Memory\n\n');
		}),
		vscode.commands.registerCommand('chomircode.agent.connectMcp', async () => {
			await connectMcpInteractive();
		}),
		vscode.commands.registerCommand('chomircode.agent.showSessions', async () => {
			await showSessionsInteractive(context);
		}),
		vscode.commands.registerCommand('chomircode.agent.newSession', async () => {
			await newSessionInteractive(context);
		}),
		vscode.commands.registerCommand('chomircode.agent.cyclePermissionMode', async () => {
			await cyclePermissionMode();
		}),
		vscode.commands.registerCommand('chomircode.agent.showEngineDashboard', async () => {
			await showEngineDashboard();
		}),
		vscode.commands.registerCommand('chomircode.agent.compactContext', async () => {
			const cfg = vscode.workspace.getConfiguration('chomircode');
			const win = cfg.get<number>('contextWindow') ?? 128000;
			const reserve = cfg.get<number>('compactOutputReserve') ?? 8192;
			const buf = cfg.get<number>('autocompactBuffer') ?? 16000;
			const trigger = Math.max(0, win - reserve - buf);
			await vscode.window.showInformationMessage(
				`Auto-compact near ~${trigger} tokens (window ${win} − reserve ${reserve} − buffer ${buf}), same formula as Cursor/panda. Or send /compact in Chat.`,
			);
		}),
	);

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
		return handleChatRequest(request, chatContext, stream, token, context);
	});
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
	context.subscriptions.push(participant);

	// Seed DeepSeek into the Models picker immediately so OSS / trial builds are
	// not blocked behind "Sign in to use Copilot" when no Copilot account exists.
	void ensureDeepSeekLanguageModelGroup(context, provider);
	void promptConfigureIfNeeded(context, provider);
	provider.refresh();
}

async function promptConfigureIfNeeded(context: vscode.ExtensionContext, provider: DeepSeekLanguageModelProvider): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('chomircode');
	const apiKey = (cfg.get<string>('apiKey') || process.env.DEEPSEEK_API_KEY || '').trim();
	if (apiKey) {
		return;
	}
	const SKIP_KEY = 'chomircode.skipApiKeyPrompt';
	if (context.globalState.get<boolean>(SKIP_KEY)) {
		return;
	}
	const choice = await vscode.window.showWarningMessage(
		'DeepSeek API Key is not configured. Configure API Key and Base URL to use Chat.',
		'Configure…',
		'Later',
	);
	if (choice === 'Configure…') {
		await setApiKeyInteractive(provider);
	} else if (choice === 'Later') {
		await context.globalState.update(SKIP_KEY, true);
	}
}

async function migrateLegacyAifrontSettings(context: vscode.ExtensionContext): Promise<void> {
	const FLAG = 'chomircode.migratedFromLegacy';
	if (context.globalState.get<boolean>(FLAG)) {
		return;
	}
	const newCfg = vscode.workspace.getConfiguration('chomircode');
	const keys = [
		'apiKey', 'baseUrl', 'model', 'enginePath', 'permissionMode', 'maxRounds',
		'openChangedFiles', 'useSidecar', 'continueLastSession', 'contextWindow',
		'compactOutputReserve', 'autocompactBuffer',
	] as const;
	const legacySections = ['shiyuncode', 'aifront'] as const;
	for (const key of keys) {
		const next = newCfg.inspect(key);
		const hasNew = next?.globalValue !== undefined || next?.workspaceValue !== undefined || next?.workspaceFolderValue !== undefined;
		if (hasNew) {
			continue;
		}
		for (const section of legacySections) {
			const oldCfg = vscode.workspace.getConfiguration(section);
			const prev = oldCfg.inspect(key);
			if (prev?.globalValue !== undefined) {
				await newCfg.update(key, prev.globalValue, vscode.ConfigurationTarget.Global);
				break;
			}
			if (prev?.workspaceValue !== undefined) {
				await newCfg.update(key, prev.workspaceValue, vscode.ConfigurationTarget.Workspace);
				break;
			}
		}
	}
	for (const legacy of ['shiyuncode.skipApiKeyPrompt', 'aifront.skipApiKeyPrompt'] as const) {
		const oldSkip = context.globalState.get<boolean>(legacy);
		if (oldSkip && !context.globalState.get<boolean>('chomircode.skipApiKeyPrompt')) {
			await context.globalState.update('chomircode.skipApiKeyPrompt', true);
		}
	}
	for (const legacy of ['shiyuncode.migratedDeepSeekLmGroup', 'aifront.migratedDeepSeekLmGroup', 'shiyuncode.seededDeepSeekLmGroup.v2'] as const) {
		const oldMigrate = context.globalState.get<boolean>(legacy);
		if (oldMigrate && !context.globalState.get<boolean>('chomircode.migratedDeepSeekLmGroup')) {
			await context.globalState.update('chomircode.migratedDeepSeekLmGroup', true);
		}
	}
	await context.globalState.update(FLAG, true);
}

async function syncChomircodeSettings(config: DeepSeekConfig): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('chomircode');
	if (config.apiKey) {
		await cfg.update('apiKey', config.apiKey, vscode.ConfigurationTarget.Global);
	}
	if (config.baseUrl) {
		await cfg.update('baseUrl', normalizeBaseUrl(config.baseUrl), vscode.ConfigurationTarget.Global);
	}
}

/**
 * Always register a DeepSeek provider group so Chat's model picker treats us as
 * BYOK (`hasByokModels`) and does not force Copilot sign-in on a fresh profile.
 */
async function ensureDeepSeekLanguageModelGroup(context: vscode.ExtensionContext, provider: DeepSeekLanguageModelProvider): Promise<void> {
	const SEED_FLAG = 'chomircode.seededDeepSeekLmGroup.v2';
	const cfg = vscode.workspace.getConfiguration('chomircode');
	const apiKey = (cfg.get<string>('apiKey') || process.env.DEEPSEEK_API_KEY || '').trim();
	const baseUrl = normalizeBaseUrl(cfg.get<string>('baseUrl') || OFFICIAL_BASE_URL);
	const payload: Record<string, string> = {
		vendor: DEEPSEEK_VENDOR,
		name: 'DeepSeek',
		baseUrl,
	};
	if (apiKey) {
		payload.apiKey = apiKey;
	}

	const alreadySeeded = context.globalState.get<boolean>(SEED_FLAG);
	try {
		await vscode.commands.executeCommand('lm.migrateLanguageModelsProviderGroup', payload);
		await context.globalState.update(SEED_FLAG, true);
		provider.refresh();
	} catch (err) {
		// Group may already exist — still refresh so models populate the picker.
		if (!alreadySeeded) {
			console.warn('[chomircode-agent] ensureDeepSeekLanguageModelGroup:', err);
		}
		provider.refresh();
		await context.globalState.update(SEED_FLAG, true);
	}
}

async function setApiKeyInteractive(provider?: DeepSeekLanguageModelProvider): Promise<void> {
	const current = vscode.workspace.getConfiguration('chomircode').get<string>('apiKey') || '';
	const value = await vscode.window.showInputBox({
		title: 'Configure DeepSeek · API Key',
		prompt: 'Paste your DeepSeek API key (from platform.deepseek.com). Required to use Chat.',
		placeHolder: 'sk-…',
		password: true,
		ignoreFocusOut: true,
		value: current ? '••••••••' : '',
		validateInput: (v) => {
			if (!v || v.trim() === '••••••••') {
				return undefined;
			}
			return v.trim().startsWith('sk-') ? undefined : 'Key usually starts with sk-';
		},
	});
	if (value === undefined) {
		return;
	}
	const trimmed = value.trim();
	const keepExistingKey = !trimmed || trimmed === '••••••••';
	const apiKey = keepExistingKey ? current.trim() : trimmed;
	if (!apiKey) {
		vscode.window.showWarningMessage('API Key is required.');
		return;
	}

	const baseInput = await vscode.window.showInputBox({
		title: 'Configure DeepSeek · Base URL',
		prompt: 'OpenAI-compatible API base URL (model address)',
		placeHolder: OFFICIAL_BASE_URL,
		ignoreFocusOut: true,
		value: vscode.workspace.getConfiguration('chomircode').get<string>('baseUrl') || OFFICIAL_BASE_URL,
		validateInput: (v) => {
			const t = (v || '').trim();
			if (!t) {
				return undefined;
			}
			return /^https?:\/\//i.test(t) ? undefined : 'URL should start with http:// or https://';
		},
	});
	if (baseInput === undefined) {
		return;
	}
	const baseUrl = normalizeBaseUrl(baseInput || OFFICIAL_BASE_URL);
	await syncChomircodeSettings({ apiKey, baseUrl });
	try {
		await vscode.commands.executeCommand('lm.migrateLanguageModelsProviderGroup', {
			vendor: DEEPSEEK_VENDOR,
			name: 'DeepSeek',
			apiKey,
			baseUrl,
		});
	} catch {
		// ignore
	}
	provider?.refresh();
	disposeSidecar(); // restart with new key on next chat
	vscode.window.showInformationMessage(`DeepSeek configured. Base URL: ${baseUrl}`);
}

async function selectModelInteractive(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('chomircode');
	const current = (cfg.get<string>('model') || 'deepseek-chat').trim();
	const picked = await vscode.window.showQuickPick(
		MODEL_CHOICES.map(m => ({
			label: m.label,
			description: m.description,
			picked: m.label === current,
		})),
		{ title: 'ChomirCode · Select DeepSeek model', ignoreFocusOut: true },
	);
	if (!picked) {
		return;
	}
	await cfg.update('model', picked.label, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`ChomirCode model: ${picked.label}`);
}

async function showStatus(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('chomircode');
	const apiKey = (cfg.get<string>('apiKey') || process.env.DEEPSEEK_API_KEY || '').trim();
	const baseUrl = normalizeBaseUrl(cfg.get<string>('baseUrl') || OFFICIAL_BASE_URL);
	const model = (cfg.get<string>('model') || 'deepseek-chat').trim() || 'deepseek-chat';
	const engineRoot = resolveEngineRoot(cfg.get<string>('enginePath'));
	const keyHint = apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : '(not set)';
	const pick = await vscode.window.showQuickPick(
		[
			{ label: '$(key) Set API Key', id: 'key' },
			{ label: '$(symbol-misc) Select Model', id: 'model' },
			{ label: '$(shield) Cycle Permission Mode', id: 'perm' },
			{ label: '$(server) Engine Dashboard', id: 'dash' },
			{ label: '$(settings-gear) Open Settings', id: 'settings' },
			{ label: `${keyHint} · ${model} · ${baseUrl}`, id: 'noop', description: 'Current' },
			{ label: `Engine: ${engineRoot || '(not found)'}`, id: 'noop2' },
		],
		{ title: 'ChomirCode connection', ignoreFocusOut: true },
	);
	if (pick?.id === 'key') {
		await setApiKeyInteractive();
	} else if (pick?.id === 'model') {
		await selectModelInteractive();
	} else if (pick?.id === 'perm') {
		await cyclePermissionMode();
	} else if (pick?.id === 'dash') {
		await showEngineDashboard();
	} else if (pick?.id === 'settings') {
		await vscode.commands.executeCommand('chomircode.agent.openSettings');
	}
}

async function handleChatRequest(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	extContext: vscode.ExtensionContext,
): Promise<vscode.ChatResult> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		stream.markdown('Open a folder or workspace first so ChomirCode can edit project files.');
		return { errorDetails: { message: 'No workspace folder' } };
	}

	const cfg = vscode.workspace.getConfiguration('chomircode');
	const engineRoot = resolveEngineRoot(cfg.get<string>('enginePath'));
	if (!engineRoot) {
		stream.markdown('Could not find the ChomirCode engine. Set **chomircode.enginePath**.\n');
		stream.button({ command: 'chomircode.agent.openSettings', title: 'Open ChomirCode Settings' });
		return { errorDetails: { message: 'ChomirCode engine not found' } };
	}

	const apiKey = (cfg.get<string>('apiKey') || process.env.DEEPSEEK_API_KEY || '').trim();
	if (!apiKey && !hasEnvLocalKey(engineRoot)) {
		stream.markdown('DeepSeek API Key is not configured.\n\n');
		stream.button({ command: 'chomircode.agent.manageModels', title: 'Configure Models' });
		return { errorDetails: { message: 'Missing chomircode.apiKey' } };
	}

	const task = (request.prompt || '').trim();
	if (!task) {
		stream.markdown('Describe what you want changed. Slash commands like `/help`, `/skills`, `/memory` are supported.');
		return {};
	}

	const selectedModelId = resolveSelectedModelId(request);
	const model = selectedModelId || (cfg.get<string>('model') || 'deepseek-chat').trim() || 'deepseek-chat';
	if (selectedModelId) {
		void cfg.update('model', selectedModelId, vscode.ConfigurationTarget.Global);
	}
	const baseUrl = normalizeBaseUrl(cfg.get<string>('baseUrl') || OFFICIAL_BASE_URL);
	const permissionMode = cfg.get<string>('permissionMode') || 'acceptEdits';
	const maxRounds = cfg.get<number>('maxRounds') ?? 40;
	const openChanged = cfg.get<boolean>('openChangedFiles') !== false;
	const useSidecar = cfg.get<boolean>('useSidecar') !== false;
	const continueLast = cfg.get<boolean>('continueLastSession') !== false;
	const contextWindow = cfg.get<number>('contextWindow') ?? 128000;
	const compactOutputReserve = cfg.get<number>('compactOutputReserve') ?? 8192;
	const autocompactBuffer = cfg.get<number>('autocompactBuffer') ?? 16000;
	const workspaceRoot = folder.uri.fsPath;
	const activeFile = getActiveFileRelative(workspaceRoot);
	const resolved = resolveSessionId(chatContext, workspaceRoot, continueLast);
	const sessionId = resolved.sessionId;

	stream.markdown(
		`_ChomirCode · \`${model}\` · mode \`${permissionMode}\` · \`${path.basename(workspaceRoot)}\` · session \`${sessionId}\`${resolved.resumed ? ' (resumed)' : ''}_\n\n`,
	);
	if (resolved.resumed && chatContext.history.length === 0) {
		const prior = loadTranscriptTurns(workspaceRoot, sessionId, 24);
		const replay = formatHistoryReplayMarkdown(prior);
		if (replay) {
			stream.markdown(replay);
		} else {
			stream.markdown(
				'_Chat UI history was empty after reopen — continuing from `.panda` engine memory. Use **ChomirCode: New Session** for a blank agent._\n\n',
			);
		}
	}

	if (useSidecar) {
		try {
			return await handleViaSidecar({
				stream,
				token,
				extContext,
				workspaceRoot,
				enginePath: cfg.get<string>('enginePath'),
				apiKey: apiKey || undefined,
				baseUrl,
				model,
				permissionMode,
				maxRounds,
				task,
				activeFile,
				sessionId,
				chatContext,
				openChanged,
				contextWindow,
				compactOutputReserve,
				autocompactBuffer,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			stream.markdown(`\n\n_Sidecar failed, falling back to CLI…_\n\`${truncate(msg, 200)}\`\n\n`);
		}
	}

	return handleViaCli({
		stream,
		token,
		extContext,
		workspaceRoot,
		engineRoot,
		apiKey: apiKey || undefined,
		baseUrl,
		model,
		permissionMode,
		maxRounds,
		task,
		activeFile,
		sessionId,
		openChanged,
	});
}

async function handleViaSidecar(opts: {
	stream: vscode.ChatResponseStream;
	token: vscode.CancellationToken;
	extContext: vscode.ExtensionContext;
	workspaceRoot: string;
	enginePath?: string;
	apiKey?: string;
	baseUrl: string;
	model: string;
	permissionMode: string;
	maxRounds: number;
	task: string;
	activeFile?: string;
	sessionId: string;
	chatContext: vscode.ChatContext;
	openChanged: boolean;
	contextWindow: number;
	compactOutputReserve: number;
	autocompactBuffer: number;
}): Promise<vscode.ChatResult> {
	opts.stream.progress('Starting ChomirCode engine…');
	const sidecar = await ensureSidecar({
		enginePath: opts.enginePath,
		workspaceRoot: opts.workspaceRoot,
		apiKey: opts.apiKey,
		baseUrl: opts.baseUrl,
		model: opts.model,
		contextWindow: opts.contextWindow,
		compactOutputReserve: opts.compactOutputReserve,
		autocompactBuffer: opts.autocompactBuffer,
	});

	// Chat queues follow-ups and starts the next turn only after the previous
	// request settles. If a panda run is still marked live (stale after cancel /
	// send-now), abort it so this turn runs as a full sequential request.
	if (await pandaIsRunLive(sidecar.baseUrl, opts.sessionId)) {
		await pandaAbort(sidecar.baseUrl, opts.sessionId);
	}

	await pandaSetRuntime(sidecar.baseUrl, {
		sessionId: opts.sessionId,
		permissionMode: opts.permissionMode,
		agentMode: 'panda',
	}).catch(() => false);

	const history = buildHistory(opts.chatContext);
	const firstUser = history.find(h => h.role === 'user')?.content || opts.task;
	rememberSession(opts.workspaceRoot, opts.sessionId, firstUser);
	appendLocalChatHistory(opts.workspaceRoot, opts.sessionId, { role: 'user', content: opts.task });
	syncBridgeToWorkspaceState(opts.extContext, opts.workspaceRoot);

	const mapper = new PandaEventMapper(opts.stream, sidecar.baseUrl, opts.workspaceRoot);

	const result = await executePandaSse({
		baseUrl: sidecar.baseUrl,
		message: opts.task,
		projectRoot: opts.workspaceRoot,
		sessionId: opts.sessionId,
		model: opts.model,
		permissionMode: opts.permissionMode,
		maxRounds: opts.maxRounds,
		activeFile: opts.activeFile,
		history,
		token: opts.token,
		onEvent: (event, data) => mapper.handle(event, data),
	});

	const finalSessionId = result.sessionId || opts.sessionId;
	rememberSession(opts.workspaceRoot, finalSessionId, firstUser);
	const assistantText = (mapper.getAssistantText() || result.finalAnswer || '').trim();
	if (assistantText) {
		appendLocalChatHistory(opts.workspaceRoot, finalSessionId, {
			role: 'assistant',
			content: assistantText.slice(0, 20000),
		});
	}
	syncBridgeToWorkspaceState(opts.extContext, opts.workspaceRoot);

	if (opts.token.isCancellationRequested || result.aborted) {
		opts.stream.markdown('\n\n_Request cancelled._\n');
		return { metadata: { sessionId: finalSessionId } };
	}

	if (!result.ok) {
		const err = result.error || 'Agent failed';
		opts.stream.markdown(`\n\n**Error:** ${err}\n\n`);
		return { errorDetails: { message: err }, metadata: { sessionId: finalSessionId } };
	}

	if (!mapper.didStreamAssistant()) {
		const answer = assistantText;
		if (answer) {
			opts.stream.markdown(`\n\n${answer}\n`);
		} else {
			opts.stream.markdown('\n\n_Done (no assistant text in stream — check model/API key)._\n');
		}
	}

	const usage = mapper.getUsageLine();
	if (usage) {
		opts.stream.markdown(`\n\n_Usage: ${usage}_\n`);
	}

	const changed = result.changed.filter(Boolean);
	if (changed.length) {
		opts.stream.markdown('\n\n**Changed files**\n\n');
		for (const file of changed) {
			opts.stream.markdown(`- \`${file}\`\n`);
		}
		if (opts.openChanged) {
			await openChangedFiles(opts.workspaceRoot, changed);
		}
	}

	return {
		metadata: {
			sessionId: finalSessionId,
			changed,
			model: opts.model,
			via: 'sidecar',
		},
	};
}

async function handleViaCli(opts: {
	stream: vscode.ChatResponseStream;
	token: vscode.CancellationToken;
	extContext: vscode.ExtensionContext;
	workspaceRoot: string;
	engineRoot: string;
	apiKey?: string;
	baseUrl: string;
	model: string;
	permissionMode: string;
	maxRounds: number;
	task: string;
	activeFile?: string;
	sessionId: string;
	openChanged: boolean;
}): Promise<vscode.ChatResult> {
	rememberSession(opts.workspaceRoot, opts.sessionId, opts.task);
	appendLocalChatHistory(opts.workspaceRoot, opts.sessionId, { role: 'user', content: opts.task });
	syncBridgeToWorkspaceState(opts.extContext, opts.workspaceRoot);

	const mapper = new StreamMapper(opts.stream);
	const result = await runChomircodeAgent({
		cwd: opts.workspaceRoot,
		task: opts.task,
		apiKey: opts.apiKey,
		baseUrl: opts.baseUrl,
		model: opts.model,
		activeFile: opts.activeFile,
		permissionMode: opts.permissionMode,
		maxRounds: opts.maxRounds,
		engineRoot: opts.engineRoot,
		token: opts.token,
		onEvent: (event, data) => mapper.handle(event, data),
	});

	const finalSessionId = result.sessionId || opts.sessionId;
	rememberSession(opts.workspaceRoot, finalSessionId, opts.task);
	const answer = (result.finalAnswer || '').trim();
	if (answer) {
		appendLocalChatHistory(opts.workspaceRoot, finalSessionId, {
			role: 'assistant',
			content: answer.slice(0, 20000),
		});
	}
	syncBridgeToWorkspaceState(opts.extContext, opts.workspaceRoot);

	if (opts.token.isCancellationRequested || result.aborted) {
		opts.stream.markdown('\n\n_Request cancelled._\n');
		return { metadata: { sessionId: finalSessionId } };
	}
	if (!result.ok) {
		opts.stream.markdown(`\n\n**Error:** ${result.error || 'Agent failed'}\n`);
		return { errorDetails: { message: result.error || 'Agent failed' } };
	}
	if (answer) {
		opts.stream.markdown(`\n\n${answer}\n`);
	}
	const changed = (result.changed || []).filter(Boolean);
	if (changed.length && opts.openChanged) {
		await openChangedFiles(opts.workspaceRoot, changed);
	}
	return {
		metadata: {
			sessionId: finalSessionId,
			changed,
			via: 'cli',
		},
	};
}

function resolveSessionId(
	chatContext: vscode.ChatContext,
	workspaceRoot: string,
	continueLast: boolean,
): { sessionId: string; isNew: boolean; resumed: boolean } {
	let historySessionId: string | undefined;
	for (let i = chatContext.history.length - 1; i >= 0; i--) {
		const turn = chatContext.history[i] as any;
		const meta = turn?.result?.metadata || turn?.metadata;
		if (meta?.sessionId && typeof meta.sessionId === 'string') {
			historySessionId = meta.sessionId;
			break;
		}
	}
	let firstPrompt: string | undefined;
	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			firstPrompt = turn.prompt;
			break;
		}
	}
	return resolvePersistedSessionId({
		workspaceRoot,
		historyEmpty: chatContext.history.length === 0,
		historySessionId,
		firstPrompt,
		continueLast,
	});
}

function buildHistory(chatContext: vscode.ChatContext): Array<{ role: string; content: string }> {
	const out: Array<{ role: string; content: string }> = [];
	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			out.push({ role: 'user', content: turn.prompt });
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const parts: string[] = [];
			for (const p of turn.response) {
				if (p instanceof vscode.ChatResponseMarkdownPart) {
					const v = p.value as string | { value?: string };
					parts.push(typeof v === 'string' ? v : String(v?.value ?? ''));
				}
			}
			const content = parts.join('').trim();
			if (content) {
				out.push({ role: 'assistant', content: content.slice(0, 8000) });
			}
		}
	}
	return out.slice(-12);
}

function resolveSelectedModelId(request: vscode.ChatRequest): string | undefined {
	const id = request.model?.id?.trim();
	if (!id) {
		return undefined;
	}
	if (id.startsWith('deepseek') || DEEPSEEK_MODELS.some(m => m.id === id)) {
		return id;
	}
	if (request.model?.vendor === DEEPSEEK_VENDOR) {
		return id;
	}
	return undefined;
}

function getActiveFileRelative(workspaceRoot: string): string | undefined {
	const doc = vscode.window.activeTextEditor?.document;
	if (!doc || doc.uri.scheme !== 'file') {
		return undefined;
	}
	const rel = path.relative(workspaceRoot, doc.uri.fsPath);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
		return undefined;
	}
	return rel.split(path.sep).join('/');
}

function hasEnvLocalKey(engineRoot: string): boolean {
	try {
		const envPath = path.join(engineRoot, '.env.local');
		if (!fs.existsSync(envPath)) {
			return false;
		}
		return /^DEEPSEEK_API_KEY\s*=\s*\S+/m.test(fs.readFileSync(envPath, 'utf8'));
	} catch {
		return false;
	}
}

async function openChangedFiles(workspaceRoot: string, changed: string[]): Promise<void> {
	const limit = Math.min(changed.length, 5);
	for (let i = 0; i < limit; i++) {
		const abs = path.isAbsolute(changed[i]) ? changed[i] : path.join(workspaceRoot, changed[i]);
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
			await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
		} catch {
			// ignore
		}
	}
}

function pandaDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? path.join(folder.uri.fsPath, '.panda') : undefined;
}

async function openPandaFile(name: string, defaultContent: string): Promise<void> {
	const root = pandaDir();
	if (!root) {
		vscode.window.showWarningMessage('Open a workspace folder first.');
		return;
	}
	fs.mkdirSync(root, { recursive: true });
	const file = path.join(root, name);
	if (!fs.existsSync(file)) {
		fs.writeFileSync(file, defaultContent, 'utf8');
	}
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
	await vscode.window.showTextDocument(doc);
}

async function openPandaDir(name: string): Promise<void> {
	const root = pandaDir();
	if (!root) {
		vscode.window.showWarningMessage('Open a workspace folder first.');
		return;
	}
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}

function defaultConfigJson(): string {
	return JSON.stringify({
		autoApprove: false,
		maxRounds: 40,
		model: 'deepseek-chat',
		permissionMode: 'acceptEdits',
	}, null, 2) + '\n';
}

async function withSidecarOrWarn<T>(fn: (baseUrl: string) => Promise<T>): Promise<T | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage('Open a workspace folder first.');
		return undefined;
	}
	const cfg = vscode.workspace.getConfiguration('chomircode');
	try {
		const sidecar = await ensureSidecar({
			enginePath: cfg.get<string>('enginePath'),
			workspaceRoot: folder.uri.fsPath,
			apiKey: (cfg.get<string>('apiKey') || '').trim() || undefined,
			baseUrl: normalizeBaseUrl(cfg.get<string>('baseUrl') || OFFICIAL_BASE_URL),
			model: cfg.get<string>('model') || undefined,
		});
		return await fn(sidecar.baseUrl);
	} catch (e) {
		vscode.window.showErrorMessage(`ChomirCode sidecar: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

async function connectMcpInteractive(): Promise<void> {
	await withSidecarOrWarn(async (baseUrl) => {
		const status = await pandaGetMcp(baseUrl);
		const servers = status?.servers || status?.mcpServers || status;
		const names = Array.isArray(servers)
			? servers.map((s: any) => String(s.name || s.id || s))
			: Object.keys(servers || {});
		const pick = names.length
			? await vscode.window.showQuickPick(['(all)', ...names], { title: 'Connect MCP server' })
			: '(all)';
		if (!pick) {
			return;
		}
		const result = await pandaConnectMcp(baseUrl, pick === '(all)' ? undefined : pick);
		vscode.window.showInformationMessage(`MCP: ${JSON.stringify(result).slice(0, 200)}`);
	});
}

async function showSessionsInteractive(extContext: vscode.ExtensionContext): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage('Open a workspace folder first.');
		return;
	}
	const workspaceRoot = folder.uri.fsPath;

	let sessions: Array<{ id: string; title: string; updatedAt: number }> = listLocalSessionFiles(workspaceRoot);
	await withSidecarOrWarn(async (baseUrl) => {
		const remote = await pandaListSessions(baseUrl);
		if (remote?.length) {
			const map = new Map(sessions.map(s => [s.id, s]));
			for (const s of remote as any[]) {
				const id = String(s.id || s.sessionId || '');
				if (!id) {
					continue;
				}
				map.set(id, {
					id,
					title: String(s.title || s.lastMessage || id),
					updatedAt: Date.parse(s.updatedAt || s.createdAt || 0) || map.get(id)?.updatedAt || 0,
				});
			}
			sessions = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		}
	});

	if (!sessions.length) {
		vscode.window.showInformationMessage('No panda sessions yet. Chat once to create `.panda/sessions`.');
		return;
	}

	const pick = await vscode.window.showQuickPick(
		sessions.map(s => ({
			label: s.title.slice(0, 60) || s.id,
			description: s.id,
			detail: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : undefined,
			id: s.id,
		})),
		{ title: 'ChomirCode sessions — pick to resume (next Chat turn continues this session)' },
	);
	if (!pick) {
		return;
	}

	setResumeSession(workspaceRoot, pick.id);
	syncBridgeToWorkspaceState(extContext, workspaceRoot);

	const preview = readTranscriptPreview(workspaceRoot, pick.id);
	const doc = await vscode.workspace.openTextDocument({
		language: 'markdown',
		content: preview || `_Session ${pick.id}_`,
	});
	await vscode.window.showTextDocument(doc, { preview: true });
	vscode.window.showInformationMessage(
		`Resume armed: ${pick.id}. Next message in Chat continues this panda session (even if Chat UI history is empty).`,
	);
}

async function newSessionInteractive(extContext: vscode.ExtensionContext): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage('Open a workspace folder first.');
		return;
	}
	const id = clearSessionForNewChat(folder.uri.fsPath);
	syncBridgeToWorkspaceState(extContext, folder.uri.fsPath);
	vscode.window.showInformationMessage(`New panda session: ${id}. Next Chat turn starts fresh.`);
}

async function cyclePermissionMode(): Promise<void> {
	const modes: Array<{ id: string; label: string; description: string }> = [
		{ id: 'bypassPermissions', label: 'Auto-run (bypass)', description: 'Run all tools without asking — Cursor YOLO style' },
		{ id: 'auto', label: 'Auto (classifier)', description: 'Let the engine auto-approve safe actions; ask when unsure' },
		{ id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve workspace edits; ask for shell / risky tools' },
		{ id: 'default', label: 'Default (ask)', description: 'Confirm almost every tool action' },
		{ id: 'dontAsk', label: "Don't ask", description: 'Minimize prompts (deny risky when unsure)' },
		{ id: 'plan', label: 'Plan only', description: 'Read-only planning; no mutating tools' },
	];
	const cfg = vscode.workspace.getConfiguration('chomircode');
	const current = cfg.get<string>('permissionMode') || 'acceptEdits';
	const pick = await vscode.window.showQuickPick(
		modes.map(m => ({
			...m,
			label: `${m.id === current ? '$(check) ' : ''}${m.label}`,
			picked: m.id === current,
		})),
		{
			title: 'ChomirCode permission mode',
			placeHolder: 'Choose how tools are approved',
			ignoreFocusOut: true,
		},
	);
	if (!pick) {
		return;
	}
	await cfg.update('permissionMode', pick.id, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`ChomirCode permission mode: ${pick.id}`);
}

async function showEngineDashboard(): Promise<void> {
	await withSidecarOrWarn(async (baseUrl) => {
		const [mcp, usage, worktree, cron, tasks, swarms, slash] = await Promise.all([
			pandaGetMcp(baseUrl).catch(() => null),
			pandaGetUsage(baseUrl).catch(() => null),
			pandaGetWorktree(baseUrl).catch(() => null),
			pandaGetCron(baseUrl).catch(() => null),
			pandaGetTasks(baseUrl).catch(() => null),
			pandaGetSwarms(baseUrl).catch(() => null),
			pandaListSlashCommands(baseUrl).catch(() => []),
		]);
		const doc = await vscode.workspace.openTextDocument({
			language: 'markdown',
			content: [
				'# ChomirCode Engine Dashboard',
				'',
				`Base: ${baseUrl}`,
				'',
				'## Usage',
				'```json',
				JSON.stringify(usage, null, 2),
				'```',
				'',
				'## MCP',
				'```json',
				JSON.stringify(mcp, null, 2),
				'```',
				'',
				'## Worktree',
				'```json',
				JSON.stringify(worktree, null, 2),
				'```',
				'',
				'## Cron',
				'```json',
				JSON.stringify(cron, null, 2),
				'```',
				'',
				'## Background tasks',
				'```json',
				JSON.stringify(tasks, null, 2),
				'```',
				'',
				'## Swarms',
				'```json',
				JSON.stringify(swarms, null, 2),
				'```',
				'',
				`## Slash commands (${slash.length})`,
				slash.slice(0, 40).map(c => `- \`/${c.name.replace(/^\//, '')}\` ${c.description || ''}`).join('\n'),
				'',
				'## Workspace `.panda`',
				'- ChomirCode: Open MCP Config',
				'- ChomirCode: Open Permissions',
				'- ChomirCode: Open Hooks',
				'- ChomirCode: Open Skills Folder',
				'- ChomirCode: Open Memory',
			].join('\n'),
		});
		await vscode.window.showTextDocument(doc, { preview: true });
	});
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + '…' : s;
}

export function deactivate(): void {
	disposeSidecar();
}
