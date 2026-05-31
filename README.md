# Pay How Much Bot

> Recurring bill reminders & OCR-powered bill splitter for Telegram.

**[@PayHowMuchBot](https://t.me/PayHowMuchBot)** · **[split.commonertech.dev](https://split.commonertech.dev)**

## Features

### 1. Subscription Reminders

Split recurring subscriptions (Netflix, Spotify, Disney+) with friends and never chase people for payment again. Set up a recurring reminder in any group or DM — the bot pings at your chosen interval automatically.

**Commands**

- `/setreminder` — set up a new recurring reminder
- `/showreminder` — view current reminder
- `/updatereminder` — edit reminder details
- `/deletereminder` — remove reminder
- `/cancel` — stop any ongoing setup

### 2. Bill Splitter

Scan a restaurant receipt or enter items manually, fix any OCR errors, mark items shared unevenly, and get an instant per-person breakdown with GST and service charge applied.

**Commands**

- `/split` — start a new bill split
  **Web app**: [split.commonertech.dev](https://split.commonertech.dev)

---

## Tech Stack

TypeScript · Cloudflare Workers · Cloudflare D1 · Cloudflare Pages · Telegram Bot API · OCR.space
