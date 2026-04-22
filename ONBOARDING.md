# Onboarding a new family

Runbook for adding a paying family (or test family) to the bot.
~3 minutes per family.

## Prerequisites

- Their Telegram user ID(s). Easiest way to get: have them send any message to
  [@userinfobot](https://t.me/userinfobot) on Telegram, which replies with their ID.
- A Telegram chat ID where cron notifications should go. Usually same as their
  user ID for 1-on-1 DM mode.
- 5 minutes access to the Supabase SQL Editor.

## Steps

### 1. Add their Telegram IDs to the env allowlist

On Vercel → Settings → Environment Variables, edit `ALLOWED_TELEGRAM_IDS`
and append their ID(s), comma-separated. Redeploy so the change takes effect.

Example: if current value is `123456,234567`, new value is `123456,234567,<NEW_ID>`.

### 2. Create family + users + seed categories

Open the Supabase SQL Editor and run this, replacing placeholders.

```sql
-- Create the family and capture its UUID
WITH new_family AS (
  INSERT INTO families (name, primary_chat_id)
  VALUES ('Family name', 123456789)   -- name, primary chat ID
  RETURNING id
),
inserted_users AS (
  INSERT INTO users (telegram_id, name, family_id)
  SELECT unnest(ARRAY[111111111, 222222222]::bigint[]),      -- member TG IDs
         unnest(ARRAY['Member A', 'Member B']),              -- display names
         id
  FROM new_family
  RETURNING family_id, id, name, telegram_id
)
SELECT * FROM inserted_users;
```

Copy the `family_id` from the output. Use it in step 3.

### 3. Seed default categories

```sql
SELECT seed_default_categories_for_family('<FAMILY_UUID>');
```

Verifies 10 rows return successfully (Жильё, Продукты, Транспорт, Кафе & выход,
Балапанчик, Здоровье, Кредиты, Личное, Savings, Разное).

### 4. (Optional) Pre-create a goal for a warm onboarding experience

If you want the new user to see the goal progress line on their very first
expense reply, insert a goal before the onboarding call:

```sql
INSERT INTO goals (family_id, name, target_amount, deadline, status)
VALUES ('<FAMILY_UUID>', 'Отпуск 2026', 1000000, '2026-12-31', 'active');
```

Otherwise, let the user create one during the call by saying
"хочу накопить 1 000 000 на отпуск к декабрю" — the bot proposes + they
confirm with the ✅ Да button.

### 5. Smoke test

Have the user send any expense like `кофе 500`. Verify:
- Bot replies with category + month summary
- Goal progress line appears at the bottom (if you did step 4)
- Dashboard at `/transactions` (if they have access) shows their entry scoped
  to their family

### 6. (Optional) Teach the user the core NL commands

Share these with them directly:
- `кофе 500` — log an expense
- `зарплата 500000` — log income (any text with "зарплата", "доход", etc.)
- `взял в долг 100000 Айдар` — track a debt
- `сколько на чипсы в этом месяце?` — NL search
- `покажи последние 10 трат` / `покажи траты за неделю` — list
- `хочу накопить 500000 на машину к 2027-01-01` — propose a goal
- `отложил 50000` — add to the active goal
- `создай категорию Спорт с эмодзи 🏃` — add a custom category
- Tap `✅ Да` on confirmation prompts to execute write actions.

## Remove a family

If a paying family stops (churns), just remove their Telegram IDs from the
`ALLOWED_TELEGRAM_IDS` env var and redeploy. The bot will stop accepting their
messages. Data stays in the DB. If you want a hard delete:

```sql
-- CAREFUL: this cascades to transactions, goals, monthly_plans, debts, etc.
DELETE FROM families WHERE id = '<FAMILY_UUID>';
```

## Troubleshooting

### "Пользователь не найден в системе" error

The user's `telegram_id` doesn't match any row in `users`. Check:
- You added them to `users` table with the correct Telegram ID
- They're messaging the bot from the same Telegram account you registered

### "null value in column 'family_id' violates not-null constraint"

Some INSERT path isn't passing `family_id`. Find the offending caller and fix
it to resolve `family_id` from the authenticated user. Check `queries.ts` for
which helper was used.

### Cron notifications not reaching a family

- Verify `families.primary_chat_id` is set (non-null)
- Verify `TELEGRAM_BOT_TOKEN` env var matches the bot that member is DMing
- Hit the cron URL manually: `curl -H "Authorization: Bearer <CRON_SECRET>" 
  https://<your-vercel-url>/api/cron/weekly-digest` — check the JSON response
  for per-family `sent: false, reason: ...`
