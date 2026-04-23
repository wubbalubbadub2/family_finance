# Admin onboarding: adding a new family to the bot

~3 minutes per family. No default categories — users create their own via the bot (see `USER_GUIDE.md`).

## Prerequisites

- The new user's Telegram **numeric user ID**. They can get it by messaging [@userinfobot](https://t.me/userinfobot) and forwarding you the reply.
- For group chats: the **chat_id** of the group (negative number). Easiest way to get it: add the bot to the group, have it post a test message, check the Vercel function log — `ctx.chat.id` is logged by the webhook.
- 2 minutes access to the Supabase SQL Editor + Vercel env settings.

## Steps

### 1. Add their Telegram user ID(s) to `ALLOWED_TELEGRAM_IDS`

Vercel → **Settings → Environment Variables** → edit `ALLOWED_TELEGRAM_IDS` (comma-separated). For a group with 3 family members, add all 3 user IDs. Redeploy.

### 2. Create the family row + user rows in Supabase

Open **SQL Editor**, replace placeholders, run:

```sql
WITH new_family AS (
  INSERT INTO families (name, primary_chat_id)
  VALUES ('Psychologist Family', 123456789)  -- name, primary chat ID (group or user)
  RETURNING id
)
INSERT INTO users (telegram_id, name, family_id)
SELECT unnest(ARRAY[111111111, 222222222]::bigint[]),  -- each member's Telegram user ID
       unnest(ARRAY['Имя жены', 'Имя мужа']),           -- display names
       id
FROM new_family
RETURNING family_id, id, name, telegram_id;
```

Copy the `family_id` from the output. Bot is now active for them.

**`primary_chat_id` is where cron notifications go.** For a solo user → their Telegram user ID. For a group → the group chat ID (negative number).

### 3. Send them `USER_GUIDE.md`

Screenshot or export it to PDF/image. They follow the 7 steps.

Their first message to the bot should be a `создай категории: ...` line. Once that's confirmed, everything else works.

### 4. Watch the first few minutes

Stay on Telegram. If they hit a bug (bot silent, wrong category, confusing reply), you see it live and can debug.

---

## Removing a family

```sql
-- Hard delete (cascades to transactions, goals, monthly_plans, debts, etc.)
DELETE FROM families WHERE id = '<FAMILY_UUID>';
```

Then remove their Telegram IDs from `ALLOWED_TELEGRAM_IDS` in Vercel and redeploy.

For a soft disable (keep data, block messages): just remove from `ALLOWED_TELEGRAM_IDS`.

---

## Troubleshooting

**"Пользователь не найден в системе"**
→ They messaged before you added them to the `users` table, OR their Telegram ID doesn't match what you registered.

**"категория не найдена"**
→ They tried to log an expense before creating any categories. Tell them to do step 2 of `USER_GUIDE.md` first.

**Cron notifications not arriving**
→ `families.primary_chat_id` is null, or the bot isn't a member of that chat. Check that the bot has posted in that chat at least once.

**Bot silent (no reply at all)**
→ Check Vercel function logs for the webhook. Look for `[chat] iter N` log lines to see if Claude hit a timeout or an error. The 45s loop deadline should now prevent total silence — user sees at least a "это заняло долго, попробуй проще" message.

**Markdown formatting broken in bot replies**
→ Harmless. `handlers.ts` falls back to plain text if Telegram rejects Markdown (common when user comments contain unescaped `*`, `_`, `[`).
