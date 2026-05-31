import { Env, sendMessage, isAdmin, getSession, setSession, clearSession, nextRemindAt, answerCallbackQuery } from './utils';

export async function handleReminderCommand(
	command: string,
	chatId: string,
	userId: string,
	isGroup: boolean,
	fromId: number,
	env: Env,
): Promise<void> {
	const token = env.TELEGRAM_BOT_TOKEN;
	const db = env.payhowmuchbot_db;

	switch (command) {
		case '/setreminder':
			await setSession(db, chatId, userId, 'awaiting_amount', {});
			await sendMessage(token, chatId, "💰 What's the total amount to be split? (e.g. 20)\n\nSend /cancel at any time to stop.");
			break;

		case '/showreminder': {
			const row = (await db.prepare(`SELECT * FROM reminders WHERE chat_id = ?`).bind(chatId).first()) as any;
			if (!row) {
				await sendMessage(token, chatId, '📭 No reminder set here yet. Use /setreminder to create one.');
				return;
			}
			const perPerson = (row.amount / row.num_people).toFixed(2);
			await sendMessage(
				token,
				chatId,
				`📋 Current reminder:\n💰 Total: $${row.amount}\n👥 People: ${row.num_people}\n💵 Per person: $${perPerson}\n📝 Description: ${row.description}\n🔁 Interval: ${row.interval}\n📅 Day: ${row.day}\n⏭ Next reminder: ${row.next_remind_at}`,
			);
			break;
		}

		case '/updatereminder': {
			const row = await db.prepare(`SELECT * FROM reminders WHERE chat_id = ?`).bind(chatId).first();
			if (!row) {
				await sendMessage(token, chatId, '📭 No reminder set yet. Use /setreminder first.');
				return;
			}
			await sendMessage(token, chatId, '✏️ What would you like to update?\n\nSend /cancel at any time to stop.', {
				inline_keyboard: [
					[
						{ text: '💰 Amount', callback_data: 'update_amount' },
						{ text: '📝 Description', callback_data: 'update_description' },
					],
					[
						{ text: '📅 Day', callback_data: 'update_day' },
						{ text: '👥 People', callback_data: 'update_people' },
					],
				],
			});
			break;
		}

		case '/deletereminder':
			await db.prepare(`DELETE FROM reminders WHERE chat_id = ?`).bind(chatId).run();
			await sendMessage(token, chatId, '🗑 Reminder deleted.');
			break;
	}
}

export async function handleReminderSession(
	session: { step: string; data: any },
	text: string,
	chatId: string,
	userId: string,
	env: Env,
): Promise<void> {
	const { step, data } = session;
	const token = env.TELEGRAM_BOT_TOKEN;
	const db = env.payhowmuchbot_db;

	switch (step) {
		case 'awaiting_amount': {
			const amount = parseFloat(text.replace('$', '').trim());
			if (isNaN(amount) || amount <= 0) {
				await sendMessage(token, chatId, '❌ Please enter a valid amount (e.g. 20).');
				return;
			}
			await setSession(db, chatId, userId, 'awaiting_interval', { amount });
			await sendMessage(token, chatId, '🔁 How often should I remind?', {
				inline_keyboard: [
					[
						{ text: 'Monthly', callback_data: 'interval_monthly' },
						{ text: 'Yearly', callback_data: 'interval_yearly' },
					],
				],
			});
			break;
		}

		case 'awaiting_description': {
			await setSession(db, chatId, userId, 'awaiting_day', { ...data, description: text });
			await sendMessage(token, chatId, '📅 Which day should I send the reminder? (1–28)');
			break;
		}

		case 'awaiting_day': {
			const day = parseInt(text.replace(/[^0-9]/g, ''));
			if (isNaN(day) || day < 1 || day > 28) {
				await sendMessage(token, chatId, '❌ Please enter a day between 1 and 28.');
				return;
			}
			await setSession(db, chatId, userId, 'awaiting_people', { ...data, day });
			await sendMessage(token, chatId, '👥 How many people are splitting this?');
			break;
		}

		case 'awaiting_people': {
			const num = parseInt(text);
			if (isNaN(num) || num < 1) {
				await sendMessage(token, chatId, '❌ Please enter a valid number of people.');
				return;
			}
			const { amount, description, interval, day } = data;
			const perPerson = (amount / num).toFixed(2);
			const next = nextRemindAt(interval, day);
			const chatType = (
				(await (
					await fetch(`https://api.telegram.org/bot${token}/getChat`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ chat_id: chatId }),
					})
				).json()) as any
			).result?.type;
			const type = chatType === 'group' || chatType === 'supergroup' ? 'group' : 'owner';

			await db
				.prepare(
					`INSERT INTO reminders (chat_id, type, description, amount, num_people, interval, day, next_remind_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(chat_id) DO UPDATE SET
					   description=excluded.description, amount=excluded.amount, num_people=excluded.num_people,
					   interval=excluded.interval, day=excluded.day, next_remind_at=excluded.next_remind_at`,
				)
				.bind(chatId, type, description, amount, num, interval, day, next)
				.run();

			await clearSession(db, chatId, userId);
			await sendMessage(
				token,
				chatId,
				`✅ Reminder set!\n📝 ${description}\n💰 Total: $${amount}\n👥 ${num} people × $${perPerson} each\n🔁 ${interval} on day ${day}\n⏭ Next reminder: ${next}`,
			);
			break;
		}

		case 'update_amount': {
			const amount = parseFloat(text.replace('$', '').trim());
			if (isNaN(amount) || amount <= 0) {
				await sendMessage(token, chatId, '❌ Please enter a valid amount.');
				return;
			}
			await db.prepare(`UPDATE reminders SET amount = ? WHERE chat_id = ?`).bind(amount, chatId).run();
			await clearSession(db, chatId, userId);
			await sendMessage(token, chatId, `✅ Amount updated to $${amount}.`);
			break;
		}

		case 'update_description': {
			await db.prepare(`UPDATE reminders SET description = ? WHERE chat_id = ?`).bind(text, chatId).run();
			await clearSession(db, chatId, userId);
			await sendMessage(token, chatId, `✅ Description updated to "${text}".`);
			break;
		}

		case 'update_day': {
			const day = parseInt(text.replace(/[^0-9]/g, ''));
			if (isNaN(day) || day < 1 || day > 28) {
				await sendMessage(token, chatId, '❌ Please enter a day between 1 and 28.');
				return;
			}
			const row = (await db.prepare(`SELECT interval FROM reminders WHERE chat_id = ?`).bind(chatId).first()) as any;
			const next = nextRemindAt(row.interval, day);
			await db.prepare(`UPDATE reminders SET day = ?, next_remind_at = ? WHERE chat_id = ?`).bind(day, next, chatId).run();
			await clearSession(db, chatId, userId);
			await sendMessage(token, chatId, `✅ Day updated to ${day}. Next reminder: ${next}`);
			break;
		}

		case 'update_people': {
			const num = parseInt(text);
			if (isNaN(num) || num < 1) {
				await sendMessage(token, chatId, '❌ Please enter a valid number.');
				return;
			}
			await db.prepare(`UPDATE reminders SET num_people = ? WHERE chat_id = ?`).bind(num, chatId).run();
			await clearSession(db, chatId, userId);
			const row = (await db.prepare(`SELECT amount FROM reminders WHERE chat_id = ?`).bind(chatId).first()) as any;
			const perPerson = (row.amount / num).toFixed(2);
			await sendMessage(token, chatId, `✅ People updated to ${num}. Per person: $${perPerson}`);
			break;
		}
	}
}

export async function handleReminderCallback(callbackQuery: any, env: Env): Promise<void> {
	const chatId = String(callbackQuery.message.chat.id);
	const userId = String(callbackQuery.from.id);
	const data = callbackQuery.data;
	const token = env.TELEGRAM_BOT_TOKEN;
	const db = env.payhowmuchbot_db;

	await answerCallbackQuery(token, callbackQuery.id);

	if (data === 'interval_monthly' || data === 'interval_yearly') {
		const interval = data === 'interval_monthly' ? 'monthly' : 'yearly';
		const session = await getSession(db, chatId, userId);
		if (!session) return;
		await setSession(db, chatId, userId, 'awaiting_description', { ...session.data, interval });
		await sendMessage(token, chatId, "📝 What's this subscription called? (e.g. Netflix)");
	}

	if (data === 'update_amount') {
		await setSession(db, chatId, userId, 'update_amount', {});
		await sendMessage(token, chatId, '💰 Enter the new total amount:\n\nSend /cancel to stop.');
	}
	if (data === 'update_description') {
		await setSession(db, chatId, userId, 'update_description', {});
		await sendMessage(token, chatId, '📝 Enter the new description:\n\nSend /cancel to stop.');
	}
	if (data === 'update_day') {
		await setSession(db, chatId, userId, 'update_day', {});
		await sendMessage(token, chatId, '📅 Enter the new day (1–28):\n\nSend /cancel to stop.');
	}
	if (data === 'update_people') {
		await setSession(db, chatId, userId, 'update_people', {});
		await sendMessage(token, chatId, '👥 Enter the new number of people:\n\nSend /cancel to stop.');
	}
}

export async function handleScheduled(env: Env): Promise<void> {
	const today = new Date().toISOString().split('T')[0];
	const rows = await env.payhowmuchbot_db.prepare(`SELECT * FROM reminders WHERE next_remind_at <= ?`).bind(today).all();

	for (const row of rows.results as any[]) {
		const perPerson = (row.amount / row.num_people).toFixed(2);
		await sendMessage(
			env.TELEGRAM_BOT_TOKEN,
			row.chat_id,
			`🔔 Time to pay for ${row.description}!\n💵 Each person pays: $${perPerson}\n👥 ${row.num_people} people splitting $${row.amount}`,
		);
		const next = nextRemindAt(row.interval, row.day);
		await env.payhowmuchbot_db.prepare(`UPDATE reminders SET next_remind_at = ? WHERE chat_id = ?`).bind(next, row.chat_id).run();
	}
}
