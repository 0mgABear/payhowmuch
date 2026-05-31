export interface Env {
	TELEGRAM_BOT_TOKEN: string;
	payhowmuchbot_db: D1Database;
	OCR_SPACE_API_KEY: string;
}

export async function sendMessage(token: string, chatId: string, text: string, replyMarkup?: object): Promise<void> {
	await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
	});
}

export async function editMessageReplyMarkup(token: string, chatId: string, messageId: number, replyMarkup: object): Promise<void> {
	await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
	});
}

export async function editMessageText(token: string, chatId: string, messageId: number, text: string, replyMarkup?: object): Promise<void> {
	await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup, parse_mode: 'Markdown' }),
	});
}

export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
	await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
	});
}

export async function isAdmin(token: string, chatId: string, userId: number): Promise<boolean> {
	const res = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, user_id: userId }),
	});
	const data = (await res.json()) as any;
	const status = data.result?.status;
	return status === 'administrator' || status === 'creator';
}

export async function deleteMessage(token: string, chatId: string, messageId: number): Promise<void> {
	await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
	});
}

export async function getSession(db: D1Database, chatId: string, userId: string): Promise<{ step: string; data: any } | null> {
	const row = (await db.prepare(`SELECT step, data FROM sessions WHERE chat_id = ? AND user_id = ?`).bind(chatId, userId).first()) as any;
	if (!row) return null;
	return { step: row.step, data: JSON.parse(row.data) };
}

export async function setSession(db: D1Database, chatId: string, userId: string, step: string, data: object): Promise<void> {
	await db
		.prepare(
			`INSERT INTO sessions (chat_id, user_id, step, data, updated_at)
			 VALUES (?, ?, ?, ?, datetime('now'))
			 ON CONFLICT(chat_id, user_id) DO UPDATE SET step=excluded.step, data=excluded.data, updated_at=excluded.updated_at`,
		)
		.bind(chatId, userId, step, JSON.stringify(data))
		.run();
}

export async function clearSession(db: D1Database, chatId: string, userId: string): Promise<void> {
	await db.prepare(`DELETE FROM sessions WHERE chat_id = ? AND user_id = ?`).bind(chatId, userId).run();
}

export function nextRemindAt(interval: string, day: number): string {
	const now = new Date();
	let next: Date;
	if (interval === 'monthly') {
		next = new Date(now.getFullYear(), now.getMonth(), day);
		if (next <= now) next = new Date(now.getFullYear(), now.getMonth() + 1, day);
	} else {
		next = new Date(now.getFullYear(), 0, day);
		if (next <= now) next = new Date(now.getFullYear() + 1, 0, day);
	}
	return next.toISOString().split('T')[0];
}
