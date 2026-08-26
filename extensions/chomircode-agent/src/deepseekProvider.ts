/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChomirCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const DEEPSEEK_VENDOR = 'deepseek';
export const OFFICIAL_BASE_URL = 'https://api.deepseek.com';

export const DEEPSEEK_MODELS = [
	{ id: 'deepseek-chat', name: 'DeepSeek Chat', family: 'deepseek-chat', detail: 'Official alias · general chat / coding' },
	{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', family: 'deepseek-reasoner', detail: 'Official alias · reasoner' },
	{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', family: 'deepseek-v4-flash', detail: 'DeepSeek V4 Flash' },
	{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', family: 'deepseek-v4-pro', detail: 'DeepSeek V4 Pro' },
] as const;

export type DeepSeekConfig = {
	apiKey?: string;
	baseUrl?: string;
};

type DeepSeekModelInfo = vscode.LanguageModelChatInformation & {
	readonly apiKey?: string;
	readonly baseUrl?: string;
};

/**
 * DeepSeek OpenAI-compatible LM provider for the Chat Models picker / Manage Models UI.
 * Vendor configuration (API key + base URL) is contributed via package.json.
 */
export class DeepSeekLanguageModelProvider implements vscode.LanguageModelChatProvider<DeepSeekModelInfo> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	private _lastConfig: DeepSeekConfig = {};

	constructor(private readonly _syncSettings: (config: DeepSeekConfig) => Thenable<void> | void) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	refresh(): void {
		this._onDidChange.fire();
	}

	getLastConfig(): DeepSeekConfig {
		return this._lastConfig;
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<DeepSeekModelInfo[]> {
		const fromOptions = (options as { configuration?: DeepSeekConfig }).configuration;
		const cfg = vscode.workspace.getConfiguration('chomircode');
		const apiKey = (fromOptions?.apiKey || cfg.get<string>('apiKey') || process.env.DEEPSEEK_API_KEY || '').trim();
		const baseUrl = normalizeBaseUrl(fromOptions?.baseUrl || cfg.get<string>('baseUrl') || process.env.DEEPSEEK_BASE_URL || OFFICIAL_BASE_URL);

		this._lastConfig = { apiKey: apiKey || undefined, baseUrl };

		if (fromOptions?.apiKey || fromOptions?.baseUrl) {
			await this._syncSettings({ apiKey: apiKey || undefined, baseUrl });
		}

		// Always list models so the Models picker is usable without Copilot sign-in.
		// When API key is missing, surface a clear hint in the picker detail.
		const needsKey = !apiKey;
		return DEEPSEEK_MODELS.map((m, index) => ({
			id: m.id,
			name: m.name,
			family: m.family,
			version: '1.0.0',
			detail: needsKey ? '⚠️ API Key not set — open “Configure API Key / Manage Models…”' : m.detail,
			tooltip: needsKey
				? `${m.name}: set API Key and Base URL via Configure API Key / Manage Models…`
				: `${m.name} via DeepSeek (${baseUrl})`,
			maxInputTokens: 128_000,
			maxOutputTokens: 8_192,
			capabilities: {
				toolCalling: true,
				imageInput: false,
			},
			isBYOK: true,
			isUserSelectable: true,
			isDefault: index === 0,
			warningText: needsKey ? { api_key: 'API Key required. Use **Configure API Key / Manage Models…** at the bottom of the Models list.' } : undefined,
			apiKey: apiKey || undefined,
			baseUrl,
		}));
	}

	async provideLanguageModelChatResponse(
		model: DeepSeekModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const apiKey = (model.apiKey || this._lastConfig.apiKey || vscode.workspace.getConfiguration('chomircode').get<string>('apiKey') || '').trim();
		if (!apiKey) {
			throw new Error('DeepSeek API Key is not configured. Open Models → Manage Models… → Add DeepSeek, or run “ChomirCode: Set API Key”.');
		}

		const baseUrl = normalizeBaseUrl(model.baseUrl || this._lastConfig.baseUrl || OFFICIAL_BASE_URL);
		const url = `${baseUrl}/chat/completions`;
		const body = {
			model: model.id,
			stream: true,
			messages: toOpenAiMessages(messages),
		};

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: toAbortSignal(token),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`DeepSeek API ${response.status}: ${text.slice(0, 400) || response.statusText}`);
		}

		if (!response.body) {
			throw new Error('DeepSeek API returned an empty body');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			if (token.isCancellationRequested) {
				try {
					await reader.cancel();
				} catch {
					// ignore
				}
				return;
			}

			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const raw of lines) {
				const line = raw.trim();
				if (!line.startsWith('data:')) {
					continue;
				}
				const data = line.slice(5).trim();
				if (!data || data === '[DONE]') {
					continue;
				}
				try {
					const parsed = JSON.parse(data) as {
						choices?: Array<{ delta?: { content?: string } }>;
					};
					const content = parsed.choices?.[0]?.delta?.content;
					if (content) {
						progress.report(new vscode.LanguageModelTextPart(content));
					}
				} catch {
					// ignore malformed SSE chunks
				}
			}
		}
	}

	async provideTokenCount(
		_model: DeepSeekModelInfo,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		if (typeof text === 'string') {
			return Math.ceil(text.length / 4);
		}
		let total = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += part.value.length;
			}
		}
		return Math.ceil(total / 4);
	}
}

export function normalizeBaseUrl(url: string): string {
	return (url || OFFICIAL_BASE_URL).trim().replace(/\/+$/, '') || OFFICIAL_BASE_URL;
}

function toOpenAiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{ role: string; content: string }> {
	const out: Array<{ role: string; content: string }> = [];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const parts: string[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				parts.push(part.value);
			}
		}
		const content = parts.join('');
		if (content) {
			out.push({ role, content });
		}
	}
	return out;
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal | undefined {
	if (typeof AbortController === 'undefined') {
		return undefined;
	}
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}
