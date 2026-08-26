/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatRequestQueueKind, IChatPendingRequest, IChatService } from '../../../common/chatService/chatService.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { ChatInputStackSlot, setChatInputStackSlot } from '../input/chatInputStack.js';

/**
 * Cursor-like pending queue strip shown above the chat input.
 * Queued / steering messages live here instead of in the transcript,
 * so they stay compact and pinned next to the composer.
 */
export class ChatPendingQueueWidget extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _sessionDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _rowDisposables = this._register(new MutableDisposable<DisposableStore>());
	private _slot: HTMLElement | undefined;
	private _visible = false;
	private _model: IChatModel | undefined;

	private _onDidRequestEdit: ((pending: IChatPendingRequest) => void) | undefined;

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super();
		this._domNode = dom.$('.chat-pending-queue-widget');
		const header = dom.append(this._domNode, dom.$('.chat-pending-queue-header'));
		dom.append(header, dom.$('span.chat-pending-queue-title', undefined, localize('chat.pendingQueue.title', "Queued")));
		this._list = dom.append(this._domNode, dom.$('.chat-pending-queue-list'));
		this._domNode.style.display = 'none';
	}

	attachTo(slot: HTMLElement): void {
		this._slot = slot;
		slot.appendChild(this._domNode);
		setChatInputStackSlot(slot, this._visible ? ChatInputStackSlot.Docked : ChatInputStackSlot.Empty);
	}

	onDidRequestEdit(handler: (pending: IChatPendingRequest) => void): void {
		this._onDidRequestEdit = handler;
	}

	setSession(model: IChatModel | undefined): void {
		this._sessionDisposables.clear();
		this._model = model;

		if (!model) {
			this.render([]);
			return;
		}

		const store = new DisposableStore();
		this._sessionDisposables.value = store;
		store.add(model.onDidChangePendingRequests(() => this.render(model.getPendingRequests())));
		this.render(model.getPendingRequests());
	}

	private render(pending: readonly IChatPendingRequest[]): void {
		const visible = pending.filter(p => !p.request.isHiddenFromTranscript);
		const rowStore = new DisposableStore();
		this._rowDisposables.value = rowStore;
		dom.clearNode(this._list);

		if (visible.length === 0) {
			this.setVisible(false);
			return;
		}

		this.setVisible(true);

		for (const item of visible) {
			this._list.appendChild(this.createRow(item, rowStore));
		}
	}

	private createRow(item: IChatPendingRequest, store: DisposableStore): HTMLElement {
		const row = dom.$('.chat-pending-queue-row');
		row.classList.toggle('steering', item.kind === ChatRequestQueueKind.Steering);

		const kindLabel = item.kind === ChatRequestQueueKind.Steering
			? localize('chat.pendingQueue.steering', "Steering")
			: localize('chat.pendingQueue.queued', "Queued");
		dom.append(row, dom.$('span.chat-pending-queue-kind', undefined, kindLabel));

		const text = item.request.message.text?.trim()
			|| localize('chat.pendingQueue.empty', "(empty)");
		const message = dom.append(row, dom.$('span.chat-pending-queue-message'));
		message.textContent = text;
		message.title = text;

		const actionsContainer = dom.append(row, dom.$('.chat-pending-queue-actions'));
		const actions = store.add(new ActionBar(actionsContainer, {
			ariaLabel: localize('chat.pendingQueue.actions', "Queue actions"),
		}));

		actions.push(store.add(new Action('chat.pendingQueue.edit', localize('chat.pendingQueue.edit', "Edit"), ThemeIcon.asClassName(Codicon.edit), true, async () => {
			this._onDidRequestEdit?.(item);
		})), { icon: true, label: false });

		actions.push(store.add(new Action('chat.pendingQueue.sendNow', localize('chat.pendingQueue.sendNow', "Send Immediately"), ThemeIcon.asClassName(Codicon.arrowUp), true, async () => {
			const sessionResource = this._model?.sessionResource;
			if (sessionResource) {
				await this.chatService.sendPendingRequestImmediately(sessionResource, item.request.id);
			}
		})), { icon: true, label: false });

		actions.push(store.add(new Action('chat.pendingQueue.remove', localize('chat.pendingQueue.remove', "Remove"), ThemeIcon.asClassName(Codicon.trash), true, async () => {
			const sessionResource = this._model?.sessionResource;
			if (sessionResource) {
				this.chatService.removePendingRequest(sessionResource, item.request.id);
			}
		})), { icon: true, label: false });

		return row;
	}

	private setVisible(visible: boolean): void {
		this._visible = visible;
		this._domNode.style.display = visible ? 'block' : 'none';
		setChatInputStackSlot(this._slot, visible ? ChatInputStackSlot.Docked : ChatInputStackSlot.Empty);
	}
}
