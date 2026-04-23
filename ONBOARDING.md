# Admin onboarding: adding a new family

**~1 minute per family.** One command in your own bot chat — no SQL, no Vercel env edits, no asking users for their Telegram ID.

---

## The flow

### 1. Create the family in your bot

In your own bot chat, type:

```
/newfamily Psychologist Family
```

The bot replies with a one-shot invite link:

```
✅ Создал семью Psychologist Family.

📎 Пригласи первого члена (ссылка действует 14 дней, одноразовая):
https://t.me/YourBot?start=invite_abc123

Когда они кликнут — их аккаунт добавится автоматически.
```

### 2. Send the link to the family admin

Forward or paste the invite link to the psychologist (or whoever is setting up the family) on Telegram.

### 3. They tap the link — done

Telegram opens the bot, sends `/start invite_abc123` to it automatically. The bot:
- Creates their user row
- Links them to the family
- Sends them a welcome message explaining the next step (create categories)

From their side, it looks like a single tap + a welcome. No code entry, no registration form.

### 4. They set up their categories via the bot

First message from them:

```
создай категории: Продукты 🛒, Транспорт 🚗, Кафе ☕, Жильё 🏠, Личное 🎯, Прочее 🎲
```

Bot shows the list + ✅ Да button. One tap creates all of them.

### 5. They start logging

```
кофе 1200
такси 2500
```

---

## Adding more people to an existing family

Anyone in a family can type `/invite` in their bot chat to get a new invite link for their OWN family. Share it with a spouse/kid/parent — they tap, they're in.

---

## Removing a family or user

```sql
-- Remove a user (they lose access immediately; their historical transactions stay)
DELETE FROM users WHERE telegram_id = 123456789;

-- Remove a family entirely (cascades to transactions, goals, plans, debts, etc.)
DELETE FROM families WHERE id = '<FAMILY_UUID>';
```

---

## Troubleshooting

**"Приглашение не найдено"** → code typed wrong or already used. Generate a new link with `/invite`.

**"Срок приглашения истёк"** → 14-day TTL hit. Generate a new link.

**"категория не найдена" on first expense** → the user tried to log before creating categories. Tell them to do step 4 first.

**Bot silent** → check Vercel function logs. The 45s loop deadline should prevent total silence; if it happens, look for `[chat] iter N` and `[chat] tool X took Yms` timing lines.

**Cron notifications not arriving** → `families.primary_chat_id` is null. Fix:
```sql
UPDATE families SET primary_chat_id = <their_chat_id> WHERE id = '<FAMILY_UUID>';
```
Their chat_id is their Telegram user_id for DMs or the group chat ID (negative) for group bots.

---

## One-time initial setup (you don't need this again)

Required env vars on Vercel:

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_BOT_HANDLE` — username without @, e.g. `FamilyBudgetBot` (used to build invite links)
- `CLAUDE_MODEL` — defaults to `claude-sonnet-4-6`; override if you want Haiku
- `CRON_SECRET` — any random string for cron auth
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- `DEFAULT_FAMILY_ID` — optional; for the web dashboard. Default `00000000-0000-0000-0000-000000000001` (your existing family).

Note: `ALLOWED_TELEGRAM_IDS` is no longer used and can be deleted. The `users` table is the allowlist now.
