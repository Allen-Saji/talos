---
title: Telegram
description: Talk to Talos from your phone via a long-polling Telegram bot.
---

The Telegram channel is a [grammY](https://grammy.dev) bot running inside `talosd`. Long-poll, no webhook, edit-in-place message streaming.

## Setup

Get a bot token from [@BotFather](https://t.me/BotFather), then:

```yaml title="~/.config/talos/channels.yaml"
channels:
  telegram:
    enabled: true
    bot_token_ref: env:TELEGRAM_BOT_TOKEN
    allowed_users: ['@yourname']
```

Set `TELEGRAM_BOT_TOKEN` in your `.env` and restart `talosd`.

## Streaming

Telegram has a strict edit-rate limit (~1/sec per chat). The adapter coalesces text deltas into one message and edits it on a tick:

```
@you: swap 0.001 ETH for USDC on uniswap

🤖 ↳ uniswap_get_quote ✓ ~2.59 USDC
🤖 ↳ uniswap_swap_exact_in
🤖   ↳ keeperhub: workflow wf_8a3c... → tx 0x17643319... → confirmed
🤖 ✓ Swapped. tx https://sepolia.etherscan.io/tx/0x17643319...
```

You see one message growing in place. No spam.

## Slash commands

Telegram bots use `/`-prefixed commands too:

| Command | Effect |
|---|---|
| `/help` | List commands |
| `/run <intent>` | Submit a run (default behavior — `/run` is optional, plain text works) |
| `/status` | Daemon health from your phone |
| `/abort` | Cancel the in-flight run |
| `/thread_new` | Reset to a fresh thread |

## Allowed users

Talos enforces an allowlist. `allowed_users` is a list of `@username` or numeric Telegram user IDs. Anyone else gets a polite refusal and the daemon logs a `tg_unauthorized` event.

## Thread keying

Telegram threads key as `tg:{chatId}` and persist forever. The chat **is** the thread.
