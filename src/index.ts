import { Env, sendMessage, isAdmin, getSession, clearSession } from './utils';
import { handleReminderCommand, handleReminderSession, handleReminderCallback, handleScheduled } from './reminder';
import { handleSplitCommand, handleSplitSession, handleSplitCallback, handleSplitDone, handleSplitPhoto } from './split';
const REMINDER_COMMANDS = ['/setreminder', '/deletereminder', '/updatereminder'];
const SPLIT_STEPS = [
	'split_groupsize',
	'split_photo',
	'split_manual_entry',
	'split_confirm',
	'split_edit',
	'split_edit_price',
	'split_edit_qty',
	'split_items',
	'split_uneven_count',
	'split_gst_confirm',
	'split_gst_manual',
];
const REMINDER_STEPS = [
	'awaiting_amount',
	'awaiting_interval',
	'awaiting_description',
	'awaiting_day',
	'awaiting_people',
	'update_amount',
	'update_description',
	'update_day',
	'update_people',
];

async function handleUpdate(update: any, env: Env): Promise<void> {
	if (update.callback_query) {
		const cbData = update.callback_query.data as string;
		if (cbData.startsWith('split_') || cbData === 'split_gst_confirm_yes' || cbData === 'split_gst_edit') {
			await handleSplitCallback(update.callback_query, env);
		} else {
			await handleReminderCallback(update.callback_query, env);
		}
		return;
	}

	const message = update.message;
	if (!message) return;

	const chatId = String(message.chat.id);
	const userId = String(message.from.id);
	const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
	const text = message.text?.trim();

	if (message.photo) {
		await handleSplitPhoto(message.photo, chatId, userId, env);
		return;
	}
	if (!text) return;

	const session = await getSession(env.payhowmuchbot_db, chatId, userId);
	if (session) {
		if (text.startsWith('/')) {
			await clearSession(env.payhowmuchbot_db, chatId, userId);
			// fall through to handle the command normally
		} else {
			if (SPLIT_STEPS.includes(session.step)) {
				await handleSplitSession(session, text, chatId, userId, env);
			} else if (REMINDER_STEPS.includes(session.step)) {
				await handleReminderSession(session, text, chatId, userId, env);
			}
			return;
		}
	}

	if (!text.startsWith('/')) return;

	const command = text.split(/\s+/)[0].toLowerCase();

	if (isGroup && REMINDER_COMMANDS.includes(command)) {
		const admin = await isAdmin(env.TELEGRAM_BOT_TOKEN, chatId, message.from.id);
		if (!admin) {
			await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, '❌ Only group admins can do that.');
			return;
		}
	}

	switch (command) {
		case '/start':
			await sendMessage(
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				`👋 Hey! I'm PayHowMuchBot.\n\nCommands:\n/setreminder — set up a recurring payment reminder\n/showreminder — see current reminder\n/updatereminder — update reminder details\n/deletereminder — delete reminder\n/split — split a restaurant bill\n/cancel — stop any ongoing setup`,
			);
			break;

		case '/setreminder':
		case '/showreminder':
		case '/updatereminder':
		case '/deletereminder':
			await handleReminderCommand(command, chatId, userId, isGroup, message.from.id, env);
			break;

		case '/split':
			await handleSplitCommand(chatId, userId, env);
			break;

		case '/cancel':
			await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, '❌ Cancelled.');
			break;

		case '/done':
			await handleSplitDone(chatId, userId, env);
			break;
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (req.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': 'https://split.commonertech.dev',
					'Access-Control-Allow-Methods': 'POST',
					'Access-Control-Allow-Headers': 'Content-Type',
				},
			});
		}

		if (req.method === 'POST' && url.pathname === '/api/scan-receipt') {
			const incoming = await req.formData();
			const formData = new FormData();
			for (const [key, value] of incoming.entries()) {
				if (key !== 'apikey') formData.append(key, value);
			}
			formData.append('apikey', env.OCR_SPACE_API_KEY);

			const ocrRes = await fetch('https://api.ocr.space/parse/image', {
				method: 'POST',
				body: formData,
			});
			const data = await ocrRes.json();
			return new Response(JSON.stringify(data), {
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': 'https://split.commonertech.dev',
				},
			});
		}

		if (req.method !== 'POST') return new Response('ok');
		const update = await req.json();
		await handleUpdate(update, env);
		return new Response('ok');
	},

	async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
		await handleScheduled(env);
	},
};
