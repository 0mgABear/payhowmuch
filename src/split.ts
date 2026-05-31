import {
	Env,
	sendMessage,
	editMessageReplyMarkup,
	answerCallbackQuery,
	deleteMessage,
	getSession,
	setSession,
	clearSession,
} from './utils';

interface ReceiptItem {
	name: string;
	price: number;
	unitPrice: number;
	qty: number;
	pax: number;
}

interface SplitSessionData {
	groupSize?: number;
	items?: ReceiptItem[];
	gst?: number;
	sc?: number;
	selectedItems?: number[];
	pendingUnevenIndex?: number;
	itemsMessageId?: number;
	gstMsgId?: number;
	processingPhotoId?: string;
	removedItems?: number[];
	editingIndex?: number;
	confirmMsgId?: number;
}

async function sendAndGetId(token: string, chatId: string, text: string, replyMarkup?: object): Promise<number> {
	const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup, parse_mode: 'Markdown' }),
	});
	const data = (await res.json()) as any;
	return data.result?.message_id ?? 0;
}

function buildConfirmKeyboard(): object {
	return {
		inline_keyboard: [
			[
				{ text: '✅ Yes, looks correct', callback_data: 'split_confirm_yes' },
				{ text: '✏️ Edit items', callback_data: 'split_confirm_no' },
			],
		],
	};
}

function buildEditListKeyboard(items: ReceiptItem[], removedIndices: number[]): object {
	const rows: object[][] = [];
	for (let i = 0; i < items.length; i++) {
		if (removedIndices.includes(i)) continue;
		const label =
			items[i].qty > 1
				? `${items[i].name}  ${items[i].qty}×$${items[i].unitPrice.toFixed(2)} = $${items[i].price.toFixed(2)}`
				: `${items[i].name}  $${items[i].price.toFixed(2)}`;
		rows.push([{ text: label, callback_data: `split_edit_select_${i}` }]);
	}
	rows.push([{ text: '✅ Done editing', callback_data: 'split_edit_done' }]);
	return { inline_keyboard: rows };
}

function buildItemActionKeyboard(index: number): object {
	return {
		inline_keyboard: [
			[
				{ text: '💰 Edit Price', callback_data: `split_edit_price_${index}` },
				{ text: '🔢 Edit Qty', callback_data: `split_edit_qty_${index}` },
			],
			[
				{ text: '🗑 Remove', callback_data: `split_edit_remove_${index}` },
				{ text: '← Back', callback_data: 'split_edit_back' },
			],
		],
	};
}

function buildItemsKeyboard(items: ReceiptItem[], selectedIndices: number[], groupSize: number): object {
	const rows: object[][] = [];
	for (let i = 0; i < items.length; i++) {
		const isSelected = selectedIndices.includes(i);
		const icon = isSelected ? '✅' : '⬜';
		const label = `${icon} ${items[i].name} $${items[i].price.toFixed(2)}`;
		rows.push([{ text: label, callback_data: `split_toggle_${i}` }]);
	}
	rows.push([
		{ text: '← Back', callback_data: 'split_items_back' },
		{ text: '➡️ Done selecting', callback_data: 'split_items_done' },
	]);
	return { inline_keyboard: rows };
}

export async function ocrReceipt(
	imageUrl: string,
	apiKey: string,
): Promise<{ items: { name: string; price: number }[]; gst: number; sc: number }> {
	const imgRes = await fetch(imageUrl);
	const imgBuffer = await imgRes.arrayBuffer();
	const bytes = new Uint8Array(imgBuffer);
	let binary = '';
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	const base64 = btoa(binary);

	const formData = new FormData();
	formData.append('base64Image', `data:image/jpeg;base64,${base64}`);
	formData.append('apikey', apiKey);
	formData.append('isOverlayRequired', 'true');
	formData.append('OCREngine', '2');
	formData.append('isTable', 'true');
	formData.append('scale', 'true');

	const res = await fetch('https://api.ocr.space/parse/image', {
		method: 'POST',
		body: formData,
	});
	const data = (await res.json()) as any;
	if (data.IsErroredOnProcessing) return { items: [], gst: 9, sc: 10 };

	const lines: { text: string; left: number; top: number }[] =
		data.ParsedResults?.[0]?.Overlay?.Lines?.map((l: any) => ({
			text: l.LineText?.trim() ?? '',
			left: l.Words?.[0]?.Left ?? 0,
			top: l.MinTop ?? 0,
		})) ?? [];

	const fullText = data.ParsedResults?.[0]?.ParsedText ?? '';

	try {
		return parseFromOverlay(lines, fullText);
	} catch (e) {
		console.log('parse error:', e);
		return { items: [], gst: 9, sc: 10 };
	}
}

function parseFromOverlay(
	lines: { text: string; left: number; top: number }[],
	fullText: string,
): { items: { name: string; price: number }[]; gst: number; sc: number } {
	let gst = 9;
	let sc = 10;
	const gstMatch = fullText.match(/gst\s*\(?(\d+(?:\.\d+)?)\s*%?\)?/i);
	const scMatch = fullText.match(/(\d+(?:\.\d+)?)\s*%?\s*service/i) || fullText.match(/service\s*charge\s*\(?(\d+(?:\.\d+)?)\s*%?\)?/i);
	if (gstMatch) gst = parseFloat(gstMatch[1]);
	if (scMatch) sc = parseFloat(scMatch[1]);

	const skipPattern =
		/sub.?total|grand.?total|total|gst|service|s\/c|svc|charge|tax|rounding|visa|cash|receipt|table|counter|date|tel|thank|master|pos|reg|no\.|qty|amount|amt|description|price|http|see you|dine|payment|payable|change|check|closed|company|supervisor|chk|tbl|fax|visit|signature|please|again|card|terminal|uob|printing|:sgd|:scd|:sad/i;

	const priceOnlyLines = lines.filter((l) => /^\$?\d+\.\d{2}$/.test(l.text));
	if (priceOnlyLines.length === 0) return parseFromText(fullText, gst, sc);

	const priceColLeft = Math.min(...priceOnlyLines.map((l) => l.left));

	const sorted = [...lines].sort((a, b) => a.top - b.top);
	const rows: { text: string; left: number; top: number }[][] = [];
	let currentRow: { text: string; left: number; top: number }[] = [];
	let lastTop = -999;

	for (const line of sorted) {
		if (line.top - lastTop > 15) {
			if (currentRow.length > 0) rows.push(currentRow);
			currentRow = [line];
		} else {
			currentRow.push(line);
		}
		lastTop = line.top;
	}
	if (currentRow.length > 0) rows.push(currentRow);

	const items: { name: string; price: number }[] = [];
	const pricesSeen = new Set<string>();
	let pendingName: string | null = null;

	for (const row of rows) {
		const nameParts = row.filter((l) => l.left < priceColLeft - 20 && !/^\$?\d+[\.,]\d{2}$/.test(l.text));
		const priceParts = row.filter((l) => l.left >= priceColLeft - 20 && /\$?\d+[\.,]\d{2}/.test(l.text));

		const nameText = nameParts
			.map((l) => l.text)
			.join(' ')
			.trim();
		const cleanName = nameText.replace(/^\d+\s+/, '').trim();
		const priceText = priceParts[priceParts.length - 1]?.text ?? '';
		const priceNum = parseFloat(priceText.replace('$', '').replace(',', '.'));

		if (nameText && skipPattern.test(nameText)) {
			pendingName = null;
			continue;
		}

		if (cleanName && !isNaN(priceNum) && priceNum > 0 && priceNum < 1000) {
			const key = `${cleanName}:${priceNum}`;
			if (!pricesSeen.has(key)) {
				pricesSeen.add(key);
				items.push({ name: cleanName, price: priceNum });
			}
			pendingName = null;
		} else if (cleanName && isNaN(priceNum) && !skipPattern.test(cleanName)) {
			pendingName = cleanName;
		} else if (!cleanName && !isNaN(priceNum) && priceNum > 0 && priceNum < 1000 && pendingName) {
			const key = `${pendingName}:${priceNum}`;
			if (!pricesSeen.has(key)) {
				pricesSeen.add(key);
				items.push({ name: pendingName, price: priceNum });
			}
			pendingName = null;
		} else {
			pendingName = null;
		}
	}

	const badNames = items.filter((i) => /^\$|×|\t|^#$|^\d/.test(i.name));
	if (badNames.length > items.length * 0.4) return { items: [], gst: 9, sc: 10 };
	return { items, gst, sc };
}

function parseFromText(ocrText: string, gst: number, sc: number): { items: { name: string; price: number }[]; gst: number; sc: number } {
	const lines = ocrText
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const items: { name: string; price: number }[] = [];
	const pricesSeen = new Set<string>();
	const skipPattern =
		/sub.?total|grand.?total|total|gst|service|s\/c|svc|charge|tax|rounding|visa|cash|receipt|table|counter|date|tel|thank|master|pos|reg|no\.|qty|amount|amt|description|price|http|see you|dine|payment|payable|change|check|closed|company|supervisor|chk|tbl|fax|visit|signature|please|again|card|terminal|uob|printing|:sgd|:scd|:sad/i;
	let pendingName: string | null = null;

	for (const line of lines) {
		if (skipPattern.test(line)) {
			pendingName = null;
			continue;
		}
		const isPriceLine = /^\$?\d+\.\d{2}$/.test(line);
		const allPrices = [...line.matchAll(/\$?(\d+\.\d{2})/g)].map((m) => parseFloat(m[1]));

		if (isPriceLine && pendingName) {
			const price = parseFloat(line.replace('$', ''));
			const key = `${pendingName}:${price}`;
			if (price > 0 && price < 1000 && !pricesSeen.has(key)) {
				pricesSeen.add(key);
				items.push({ name: pendingName, price });
			}
			pendingName = null;
		} else if (allPrices.length > 0) {
			const price = allPrices[allPrices.length - 1];
			const name = line.replace(/[\s\d.,$]+$/, '').trim();
			if (name && price > 0 && price < 1000) {
				const key = `${name}:${price}`;
				if (!pricesSeen.has(key)) {
					pricesSeen.add(key);
					items.push({ name, price });
				}
			}
			pendingName = null;
		} else {
			pendingName = line;
		}
	}
	return { items, gst, sc };
}

function formatItemsList(items: ReceiptItem[]): string {
	return items
		.map((item, i) => {
			const priceStr = item.qty > 1 ? `${item.qty}×$${item.unitPrice.toFixed(2)} = $${item.price.toFixed(2)}` : `$${item.price.toFixed(2)}`;
			return `${i + 1}. ${item.name} — ${priceStr}`;
		})
		.join('\n');
}

async function showConfirmation(token: string, chatId: string, items: ReceiptItem[], gst: number, sc: number): Promise<number> {
	return await sendAndGetId(
		token,
		chatId,
		`📋 Found *${items.length} items*:\n\n${formatItemsList(items)}\n\nAre these correct?`,
		buildConfirmKeyboard(),
	);
}

export async function handleSplitCommand(chatId: string, userId: string, env: Env): Promise<void> {
	await setSession(env.payhowmuchbot_db, chatId, userId, 'split_groupsize', {});
	await sendMessage(
		env.TELEGRAM_BOT_TOKEN,
		chatId,
		"🍽 Let's split a bill!\n\n👥 How many people in total? (including yourself)\n\nSend /cancel to stop.",
	);
}

export async function handleSplitSession(
	session: { step: string; data: SplitSessionData },
	text: string,
	chatId: string,
	userId: string,
	env: Env,
): Promise<void> {
	const { step, data } = session;
	const token = env.TELEGRAM_BOT_TOKEN;
	const db = env.payhowmuchbot_db;

	switch (step) {
		case 'split_groupsize': {
			const groupSize = parseInt(text.replace(/[^0-9]/g, ''));
			if (isNaN(groupSize) || groupSize < 2) {
				await sendMessage(token, chatId, '❌ Please enter a valid group size (at least 2).');
				return;
			}
			await setSession(db, chatId, userId, 'split_photo', { groupSize });
			await sendMessage(
				token,
				chatId,
				`👍 Group of ${groupSize}. Now send me a photo of the receipt, or enter items manually:\n\`Item Name 12.50\`\nSend /done when finished, /cancel to stop.`,
			);
			break;
		}

		case 'split_manual_entry': {
			const lines = text
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean);
			const newItems: ReceiptItem[] = [];
			const failed: string[] = [];
			let i = 0;

			while (i < lines.length) {
				const line = lines[i];
				if (/subtotal|sub total|total|svr|gst|service|charge|tax/i.test(line)) break;
				const sameLine = line.match(/^(?:\d+\s+)?(.+?)\s+\$?(\d+(?:\.\d{1,2})?)$/);
				if (sameLine) {
					const price = parseFloat(sameLine[2]);
					newItems.push({ name: sameLine[1].trim(), price, unitPrice: price, qty: 1, pax: 0 });
					i++;
					continue;
				}
				if (i + 1 < lines.length) {
					const nextPrice = lines[i + 1].match(/^\$?(\d+(?:\.\d{1,2})?)$/);
					if (nextPrice) {
						const price = parseFloat(nextPrice[1]);
						newItems.push({ name: line.replace(/^\d+\s+/, '').trim(), price, unitPrice: price, qty: 1, pax: 0 });
						i += 2;
						continue;
					}
				}
				failed.push(line);
				i++;
			}

			const items = [...(data.items ?? []), ...newItems];
			await setSession(db, chatId, userId, 'split_manual_entry', { ...data, items });

			let reply =
				newItems.length > 0
					? `✅ Added ${newItems.length} item(s):\n${items.map((it, idx) => `${idx + 1}. ${it.name} — $${it.price.toFixed(2)}`).join('\n')}`
					: '❌ Could not parse any items.';
			if (failed.length > 0) reply += `\n\n⚠️ Skipped:\n${failed.map((f) => `• ${f}`).join('\n')}`;
			reply += '\n\nSend more items or /done to continue.';
			await sendMessage(token, chatId, reply);
			break;
		}

		case 'split_edit_price': {
			const { items, editingIndex, confirmMsgId, gst, sc } = data as Required<SplitSessionData>;
			const newPrice = parseFloat(text.replace('$', '').trim());
			if (isNaN(newPrice) || newPrice <= 0) {
				await sendMessage(token, chatId, '❌ Invalid price. Enter a number like `12.50`.');
				return;
			}
			items[editingIndex].unitPrice = newPrice;
			items[editingIndex].price = parseFloat((newPrice * items[editingIndex].qty).toFixed(2));
			if (confirmMsgId) await deleteMessage(token, chatId, confirmMsgId);
			const visibleAfterPrice = items.filter((_, i) => !(data.removedItems ?? []).includes(i));
			const newConfirmMsgIdPrice = await showConfirmation(token, chatId, visibleAfterPrice, gst, sc);
			await setSession(db, chatId, userId, 'split_edit', { ...data, items, editingIndex: undefined, confirmMsgId: newConfirmMsgIdPrice });
			break;
		}

		case 'split_edit_qty': {
			const { items, editingIndex, confirmMsgId, gst, sc } = data as Required<SplitSessionData>;
			const qty = parseFloat(text.trim());
			if (isNaN(qty) || qty <= 0) {
				await sendMessage(token, chatId, '❌ Invalid quantity. Enter a number like `2`.');
				return;
			}
			items[editingIndex].qty = qty;
			items[editingIndex].price = parseFloat((items[editingIndex].unitPrice * qty).toFixed(2));
			if (confirmMsgId) await deleteMessage(token, chatId, confirmMsgId);
			const visibleAfterQty = items.filter((_, i) => !(data.removedItems ?? []).includes(i));
			const newConfirmMsgIdQty = await showConfirmation(token, chatId, visibleAfterQty, gst, sc);
			await setSession(db, chatId, userId, 'split_edit', { ...data, items, editingIndex: undefined, confirmMsgId: newConfirmMsgIdQty });
			break;
		}

		case 'split_uneven_count': {
			const { items, groupSize, selectedItems, pendingUnevenIndex, gst, sc } = data as Required<SplitSessionData>;
			const pax = parseInt(text.replace(/[^0-9]/g, ''));
			if (isNaN(pax) || pax < 1 || pax > groupSize) {
				await sendMessage(token, chatId, `❌ Please enter a number between 1 and ${groupSize}.`);
				return;
			}
			items[pendingUnevenIndex].pax = pax;
			const remaining = selectedItems.filter((i) => items[i].pax === 0);
			if (remaining.length > 0) {
				const nextIndex = remaining[0];
				await setSession(db, chatId, userId, 'split_uneven_count', { ...data, items, pendingUnevenIndex: nextIndex });
				await sendMessage(token, chatId, `👥 How many people are sharing "${items[nextIndex].name}"? (1–${groupSize})`);
			} else {
				await setSession(db, chatId, userId, 'split_gst_confirm', { ...data, items });
				const gstMsgId = await askGstSc(token, chatId, gst, sc);
				await setSession(db, chatId, userId, 'split_gst_confirm', { ...data, items, gstMsgId });
			}
			break;
		}

		case 'split_gst_manual': {
			const parts = text.trim().split(/\s+/);
			const gst = parseFloat(parts[0]) || 0;
			const sc = parseFloat(parts[1]) || 0;
			const { items, groupSize, gstMsgId } = data as Required<SplitSessionData>;
			if (gstMsgId) await deleteMessage(token, chatId, gstMsgId);
			await clearSession(db, chatId, userId);
			await sendSplitResult(token, chatId, items, groupSize, gst, sc);
			break;
		}
	}
}

export async function handleSplitDone(chatId: string, userId: string, env: Env): Promise<void> {
	const session = await getSession(env.payhowmuchbot_db, chatId, userId);
	if (!session || session.step !== 'split_manual_entry') return;

	const { items, groupSize, gst, sc } = session.data as SplitSessionData;
	const token = env.TELEGRAM_BOT_TOKEN;
	const db = env.payhowmuchbot_db;

	if (!items || items.length === 0) {
		await sendMessage(token, chatId, '❌ No items added yet. Send items as `Item Name 12.50` or /cancel to stop.');
		return;
	}

	const confirmMsgId = await showConfirmation(token, chatId, items, gst ?? 9, sc ?? 10);
	await setSession(db, chatId, userId, 'split_confirm', { groupSize, items, gst: gst ?? 9, sc: sc ?? 10, selectedItems: [], confirmMsgId });
}

export async function handleSplitPhoto(photo: any[], chatId: string, userId: string, env: Env): Promise<void> {
	const session = await getSession(env.payhowmuchbot_db, chatId, userId);
	if (!session || (session.step !== 'split_photo' && session.step !== 'split_manual_entry')) return;

	const token = env.TELEGRAM_BOT_TOKEN;
	const db = env.payhowmuchbot_db;

	const photoMsgId = photo[0]?.file_unique_id;
	if (session.data.processingPhotoId === photoMsgId) return;

	if (session.step === 'split_manual_entry') {
		await setSession(db, chatId, userId, 'split_photo', { groupSize: session.data.groupSize, processingPhotoId: photoMsgId });
	} else {
		await setSession(db, chatId, userId, 'split_photo', { ...session.data, processingPhotoId: photoMsgId });
	}

	const readingMsgId = await sendAndGetId(token, chatId, '🔍 Reading your receipt...');

	const fileId = photo[photo.length - 1].file_id;
	const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
	const fileData = (await fileRes.json()) as any;
	const filePath = fileData.result?.file_path;
	if (!filePath) {
		await deleteMessage(token, chatId, readingMsgId);
		await sendMessage(token, chatId, '❌ Could not retrieve the photo. Please try again.');
		return;
	}
	const imageUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
	const { items, gst, sc } = await ocrReceipt(imageUrl, env.OCR_SPACE_API_KEY);
	console.log('OCR items:', JSON.stringify(items), 'gst:', gst, 'sc:', sc);
	await deleteMessage(token, chatId, readingMsgId);

	const currentSession = await getSession(db, chatId, userId);
	if (!currentSession || currentSession.step !== 'split_photo') return;

	const { groupSize } = session.data as SplitSessionData;

	if (items.length === 0) {
		await setSession(db, chatId, userId, 'split_manual_entry', { groupSize, items: [] });
		await sendMessage(
			token,
			chatId,
			'❌ Could not extract items automatically.\n\n💡 Tips:\n• Crop to show only the items section\n• Ensure good lighting\n\nOr enter items manually:\n`Item Name 12.50`\nSend /done when finished, /cancel to stop.',
		);
		return;
	}

	const receiptItems: ReceiptItem[] = items.map((i) => ({ ...i, unitPrice: i.price, qty: 1, pax: 0 }));
	const confirmMsgId = await showConfirmation(token, chatId, receiptItems, gst, sc);
	await setSession(db, chatId, userId, 'split_confirm', {
		groupSize,
		items: receiptItems,
		gst,
		sc,
		selectedItems: [],
		removedItems: [],
		confirmMsgId,
	});
}

export async function handleSplitCallback(callbackQuery: any, env: Env): Promise<void> {
	const chatId = String(callbackQuery.message.chat.id);
	const userId = String(callbackQuery.from.id);
	const cbData = callbackQuery.data;
	const token = env.TELEGRAM_BOT_TOKEN;
	const db = env.payhowmuchbot_db;

	await answerCallbackQuery(token, callbackQuery.id);

	const session = await getSession(db, chatId, userId);
	if (!session) return;

	const data = session.data as SplitSessionData;
	let { items, selectedItems, groupSize, gst, sc, itemsMessageId, gstMsgId } = data as Required<SplitSessionData>;

	if (cbData === 'split_confirm_yes') {
		if (data.confirmMsgId) await deleteMessage(token, chatId, data.confirmMsgId);
		const keyboard = buildItemsKeyboard(items, [], groupSize);
		const msg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: `👥 Tap any items *not* split equally by all ${groupSize} people, then tap ➡️ Done.\n\n${formatItemsList(items)}`,
				reply_markup: keyboard,
				parse_mode: 'Markdown',
			}),
		});
		const msgData = (await msg.json()) as any;
		await setSession(db, chatId, userId, 'split_items', { ...data, selectedItems: [], itemsMessageId: msgData.result?.message_id });
		return;
	}

	if (cbData === 'split_confirm_no') {
		if (data.confirmMsgId) await deleteMessage(token, chatId, data.confirmMsgId);
		const newMsgId = await sendAndGetId(
			token,
			chatId,
			`✏️ Tap an item to edit or remove it.\n\n${formatItemsList(items)}`,
			buildEditListKeyboard(items, []),
		);
		await setSession(db, chatId, userId, 'split_edit', { ...data, removedItems: [], confirmMsgId: newMsgId });
		return;
	}

	if (cbData.startsWith('split_edit_select_')) {
		const index = parseInt(cbData.replace('split_edit_select_', ''));
		await editMessageReplyMarkup(token, chatId, data.confirmMsgId!, buildItemActionKeyboard(index));
		await setSession(db, chatId, userId, 'split_edit', { ...data, editingIndex: index });
		return;
	}

	if (cbData === 'split_edit_back') {
		const removedItems = data.removedItems ?? [];
		await editMessageReplyMarkup(token, chatId, data.confirmMsgId!, buildEditListKeyboard(items, removedItems));
		await setSession(db, chatId, userId, 'split_edit', { ...data, editingIndex: undefined });
		return;
	}

	if (cbData.startsWith('split_edit_remove_')) {
		const index = parseInt(cbData.replace('split_edit_remove_', ''));
		const removedItems = [...(data.removedItems ?? []), index];
		const remainingItems = items.filter((_, i) => !removedItems.includes(i));
		if (data.confirmMsgId) await deleteMessage(token, chatId, data.confirmMsgId);
		const newMsgId = await sendAndGetId(
			token,
			chatId,
			`✏️ Tap an item to edit or remove it.\n\n${formatItemsList(remainingItems)}`,
			buildEditListKeyboard(items, removedItems),
		);
		await setSession(db, chatId, userId, 'split_edit', { ...data, removedItems, confirmMsgId: newMsgId, editingIndex: undefined });
		return;
	}

	if (cbData.startsWith('split_edit_price_')) {
		const index = parseInt(cbData.replace('split_edit_price_', ''));
		await editMessageReplyMarkup(token, chatId, data.confirmMsgId!, { inline_keyboard: [] });
		await sendMessage(
			token,
			chatId,
			`💰 Enter new unit price for *${items[index].name}* (current: $${items[index].unitPrice.toFixed(2)}):`,
		);
		await setSession(db, chatId, userId, 'split_edit_price', { ...data, editingIndex: index });
		return;
	}

	if (cbData.startsWith('split_edit_qty_')) {
		const index = parseInt(cbData.replace('split_edit_qty_', ''));
		await editMessageReplyMarkup(token, chatId, data.confirmMsgId!, { inline_keyboard: [] });
		await sendMessage(
			token,
			chatId,
			`🔢 Enter quantity for *${items[index].name}* (unit price: $${items[index].unitPrice.toFixed(2)}, current qty: ${items[index].qty}):`,
		);
		await setSession(db, chatId, userId, 'split_edit_qty', { ...data, editingIndex: index });
		return;
	}

	if (cbData === 'split_edit_done') {
		const removedItems = data.removedItems ?? [];
		const filteredItems = items.filter((_, i) => !removedItems.includes(i));
		if (data.confirmMsgId) await deleteMessage(token, chatId, data.confirmMsgId);
		const keyboard = buildItemsKeyboard(filteredItems, [], groupSize);
		const msg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: `👥 Tap any items *not* split equally by all ${groupSize} people, then tap ➡️ Done.\n\n${formatItemsList(filteredItems)}`,
				reply_markup: keyboard,
				parse_mode: 'Markdown',
			}),
		});
		const msgData = (await msg.json()) as any;
		await setSession(db, chatId, userId, 'split_items', {
			...data,
			items: filteredItems,
			selectedItems: [],
			itemsMessageId: msgData.result?.message_id,
		});
		return;
	}

	if (cbData === 'split_items_back') {
		if (itemsMessageId) await deleteMessage(token, chatId, itemsMessageId);
		const confirmMsgId = await showConfirmation(token, chatId, items, gst, sc);
		await setSession(db, chatId, userId, 'split_confirm', { ...data, confirmMsgId, itemsMessageId: undefined, selectedItems: [] });
		return;
	}

	if (cbData.startsWith('split_toggle_')) {
		const index = parseInt(cbData.replace('split_toggle_', ''));
		if (selectedItems.includes(index)) {
			selectedItems = selectedItems.filter((i) => i !== index);
		} else {
			selectedItems = [...selectedItems, index];
		}
		await setSession(db, chatId, userId, 'split_items', { ...data, selectedItems });
		const keyboard = buildItemsKeyboard(items, selectedItems, groupSize);
		await editMessageReplyMarkup(token, chatId, itemsMessageId, keyboard);
		return;
	}

	if (cbData === 'split_items_done') {
		if (itemsMessageId) await deleteMessage(token, chatId, itemsMessageId);

		if (selectedItems.length === 0) {
			await setSession(db, chatId, userId, 'split_gst_confirm', { ...data, selectedItems });
			const newGstMsgId = await askGstSc(token, chatId, gst, sc);
			await setSession(db, chatId, userId, 'split_gst_confirm', { ...data, selectedItems, gstMsgId: newGstMsgId });
			return;
		}

		const firstIndex = selectedItems[0];
		for (const i of selectedItems) items[i].pax = 0;
		await setSession(db, chatId, userId, 'split_uneven_count', { ...data, items, selectedItems, pendingUnevenIndex: firstIndex });
		await sendMessage(
			token,
			chatId,
			`👥 How many people are sharing "${items[firstIndex].name}"? (1–${groupSize})\n\nSend /cancel to stop.`,
		);
	}

	if (cbData === 'split_gst_confirm_yes') {
		if (gstMsgId) await deleteMessage(token, chatId, gstMsgId);
		await clearSession(db, chatId, userId);
		await sendSplitResult(token, chatId, items, groupSize, gst, sc);
	}

	if (cbData === 'split_gst_edit') {
		await setSession(db, chatId, userId, 'split_gst_manual', data);
		await sendMessage(
			token,
			chatId,
			'✏️ Enter GST% and SC% separated by a space (e.g. `9 10`).\nEnter `0` for none.\n\nSend /cancel to stop.',
		);
	}
}

async function askGstSc(token: string, chatId: string, gst: number, sc: number): Promise<number> {
	return await sendAndGetId(
		token,
		chatId,
		`📊 GST/Service Charge:\n${sc > 0 ? `• Service Charge: ${sc}%\n` : ''}${gst > 0 ? `• GST: ${gst}%\n` : ''}\nIs this correct?`,
		{
			inline_keyboard: [
				[
					{ text: '✅ Yes', callback_data: 'split_gst_confirm_yes' },
					{ text: '✏️ Edit', callback_data: 'split_gst_edit' },
				],
			],
		},
	);
}

async function sendSplitResult(
	token: string,
	chatId: string,
	items: ReceiptItem[],
	groupSize: number,
	gst: number,
	sc: number,
): Promise<void> {
	const scMult = 1 + sc / 100;
	const gstMult = 1 + gst / 100;

	const paxGroups = new Map<number, { items: ReceiptItem[]; total: number }>();
	for (const item of items) {
		const effectivePax = item.pax === 0 ? groupSize : item.pax;
		if (!paxGroups.has(effectivePax)) paxGroups.set(effectivePax, { items: [], total: 0 });
		const group = paxGroups.get(effectivePax)!;
		group.items.push(item);
		group.total += item.price;
	}

	let result = `🧾 *Bill Split Result*\n`;
	if (sc > 0) result += `📌 Service Charge: ${sc}%\n`;
	if (gst > 0) result += `📌 GST: ${gst}%\n`;
	result += `\n`;

	for (const [pax, group] of paxGroups) {
		const totalWithCharges = group.total * scMult * gstMult;
		const perPerson = totalWithCharges / pax;
		const itemNames = group.items.map((i) => `  • ${i.name} $${i.price.toFixed(2)}`).join('\n');
		result += `👥 Split by ${pax} ${pax === 1 ? 'person' : 'people'}:\n${itemNames}\n💵 Each pays: *$${perPerson.toFixed(2)}*\n\n`;
	}

	const grandTotal = items.reduce((sum, item) => sum + item.price, 0) * scMult * gstMult;
	result += `💳 Grand Total: *$${grandTotal.toFixed(2)}*`;

	await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text: result, parse_mode: 'Markdown' }),
	});
}
