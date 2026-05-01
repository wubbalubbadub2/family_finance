# Family Finance Bot — Architecture

Telegram bot serving multiple paying families. Each family owns isolated financial data (transactions, categories, goals, monthly limits). Messages dispatch to a Russian-speaking LLM agent that interprets intent, calls tools, and replies.

This document describes the system **as it is on 2026-05-01**. Aspirational pieces are marked **[planned]**.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Webhook ingress | Vercel serverless function (`bom1` region) | Free tier, HTTP-only, region-aligned with Supabase Mumbai |
| Bot framework | grammy (v1.x) | First-class TypeScript, idiomatic webhook handling |
| Database | Supabase Postgres (Mumbai `ap-south-1`) | Free tier, JS client, row-level security available |
| LLM | Anthropic Claude Sonnet 4.6 | Reliable Russian intent routing + tool calling |
| Frontend (admin) | Next.js App Router on Vercel | Same project as the webhook |
| Logs / errors | Sentry + a small `error_log` Postgres table | Captures unhandled errors and intentional incidents |
| Backups | Weekly `pg_dump --format=custom` to local + GitHub Action | Per-family restore documented |

There is **no job queue**, **no admin panel as a separate app**, and **no RLS** yet — see §8 (planned).

---

## 2. Design principles

These were extracted from real production bugs, not designed up-front. Each one has an incident behind it.

1. **Reply-from-result.** The user-facing confirmation is rendered from the DB row of the actual write, never from the LLM's tool-call arguments. A hallucinated `Записала` is structurally impossible because the formatter only runs after a successful insert. *Origin: Akbota's "Супермаркет 1762тг" incident.*

2. **Chat is the routing primitive.** `(chat_id) → family_id` is the routing table. Group support and DM support collapse into one rule. The sender's `telegram_id` is preserved on each transaction row for attribution but does not gate access. *Origin: Phase 2 work to support family groups.*

3. **LLM-first intent recognition, deterministic recovery on hallucination.** Sonnet handles all write intents (`log_expense`, `log_income`, `log_debt`, plus all `propose_*` confirmations). When Sonnet returns a `✅ NNN ₸` shaped reply WITHOUT having called a tool, a guard rejects the fake reply and falls back to deterministic parsers (income → debt → expense, in that order) to actually log the row. The parsers are never primary — only safety net. *Origin: 2026-05-01 dev test where Sonnet pattern-matched a previous "✅ Fun — 1 000 ₸" reply and fabricated an identical-looking text without calling `log_expense`.*

4. **Conversation history is the default state mechanism.** Last 10 messages from `conversation_messages` are passed to Sonnet on every turn. Multi-turn flows (slot stitching) work because Sonnet sees what was already said. Explicit `pending_*` rows exist only for the inline-keyboard confirm pattern (see §5.3).

5. **Almaty timezone everywhere.** All `transaction_date`, period queries, "today", and weekly digests resolve in `Asia/Almaty`. There is no per-family timezone column **[planned]** — current users are all in Kazakhstan.

6. **Scope by `family_id` at the query layer.** Every domain query takes a `familyId` parameter and includes `WHERE family_id = $1`. There is a tenant-scope test (`tenant-scope.test.ts`) that exercises every read query against two real families and asserts no cross-family rows. RLS would be more defensible by construction; we don't have it yet.

7. **Idempotency via heuristic dedup, not real keys [planned].** `findRecentDuplicate` rejects identical (`family_id`, `amount`, `comment`) within a 10-minute window. This catches retries and double-taps but not legitimate "two coffees same price". A real `(source_chat_id, telegram_message_id)` unique key is the right design but not built.

---

## 3. Component diagram

```
┌────────────────┐    POST /api/telegram/webhook
│  Telegram BoT  ├──────────────────────────────────┐
│  Update        │  X-Telegram-Bot-Api-Secret-Token │
└────────────────┘                                  │
                                                    ▼
                                    ┌─────────────────────────────┐
                                    │ Vercel function (bom1)      │
                                    │ ─ secret_token verify       │
                                    │ ─ grammy webhookCallback    │
                                    │ ─ 55s timeout budget        │
                                    └────────────┬────────────────┘
                                                 │
                                                 ▼
                            ┌────────────────────────────────────┐
                            │ src/lib/bot/handlers.ts            │
                            │ ─ resolveFamilyForChat(chat_id)    │
                            │ ─ getOrCreateUserInFamily          │
                            │ ─ admin commands (/newfamily)      │
                            │ ─ chat(text, ctx) for everything   │
                            │   else                             │
                            └────────────┬───────────────────────┘
                                         │
                                         ▼
                            ┌────────────────────────────────────┐
                            │ src/lib/claude/agent.ts            │
                            │ ─ undo fast-path                   │
                            │ ─ meaningful-input short-circuit   │
                            │ ─ Sonnet agent loop (≤5 iters,     │
                            │   ≤45s budget):                    │
                            │     READ_TOOLS, DIRECT_WRITE_TOOLS,│
                            │     WRITE_TOOLS                    │
                            │ ─ hallucination guard +            │
                            │   parser recovery                  │
                            └────────────┬───────────────────────┘
                                         │ service-role JWT
                                         ▼
                            ┌────────────────────────────────────┐
                            │ Supabase Postgres                  │
                            │ (~15 tables, see §4)               │
                            └────────────────────────────────────┘
```

---

## 4. Data model

### 4.1 Identity & routing

| Table | PK | Purpose |
|---|---|---|
| `families` | `id` UUID | A paying customer. Single source of truth for tenant identity. |
| `users` | `id` UUID | A Telegram user known to the system. `telegram_id` unique. `family_id` for backward compat (Phase 2 made `family_chats` authoritative). |
| `family_chats` | `chat_id` BIGINT | Routing. One row per Telegram chat (DM or group) bound to one family. |
| `family_invites` | `id` UUID | Single-use codes redeemed via `/start invite_<code>`. |

### 4.2 Domain

| Table | PK | Notes |
|---|---|---|
| `categories` | `id` BIGSERIAL | Per-family. Soft-delete via `is_active=false`. |
| `transactions` | `id` UUID | `type ∈ {expense, income}`, `category_id`, `amount`, `comment`, `transaction_date` (Almaty). Soft-delete via `deleted_at`. |
| `debts` | `id` UUID | `name`, `original_amount`, `remaining_amount`. |
| `goals` | `id` UUID | One active goal per family at a time. `target_amount`, `current_amount`, `deadline`. |
| `goal_contributions` | `id` UUID | Append-only history. |
| `monthly_plans` | `id` UUID | Per-category limit per (year, month). Upsert on `(family_id, year, month, category_id, plan_type)`. |
| `category_overrides` | `id` UUID | Learned "this keyword → this category" rules from user corrections. Consulted before LLM categorizer. |
| `pending_confirms` | `id` UUID | Sparse. One row per chat when a `propose_*` write is awaiting user tap. Stale rows cleaned daily. |
| `conversation_messages` | `id` UUID | Last ~hour of chat history per `(family_id, telegram_chat_id)`. Fed to Sonnet. |
| `error_log` | `id` UUID | Append-only audit of bot-side incidents (capture errors + hallucination_guard fires). |

### 4.3 Migrations

`supabase/migrations/` — numbered sequentially. Notable:

- `007` — per-family categories (multi-tenancy refactor).
- `011` — universal default categories (Продукты, Жильё, Транспорт, Кафе, Здоровье, Личное, Накопления, Разное). Replaced Shynggys-family-specific seeds.
- `012` — `family_chats` table + DM backfill.

All migrations are additive. No expand/contract policy enforced; migrations run live in prod. **[planned]: schema migration policy.**

---

## 5. Message processing

### 5.1 Pipeline

```
incoming Telegram update
    │
    ▼
verify X-Telegram-Bot-Api-Secret-Token  ──── reject if missing/wrong
    │
    ▼
grammy.webhookCallback (55s timeout)
    │
    ▼
handlers.ts message dispatch
    │
    ├── /start invite_<code>  → handleInviteArrival
    ├── /newfamily NAME       → handleNewFamilyCommand
    ├── my_chat_member event  → group bind + welcome (Phase 2)
    └── normal message        → resolveFamilyForChat(chat_id)
                                  │
                                  ├── unbound + sender registered → auto-link this chat
                                  └── unbound + sender not registered → reject (DM) / silent (group)
                                  │
                                  ▼
                                getOrCreateUserInFamily(sender)
                                  │
                                  ▼
                                chat(text, telegramId, name, chatId, familyId)
```

### 5.2 The `chat()` agent loop

```
chat()
  │
  ├── isMeaningfulInput(text) === false  → "не понял"  (lone "?", "...")
  │
  ├── isUndoRequest(text)                → handleUndo  (single keyword fast-path)
  │
  ├── lazy-seed default categories (idempotent)
  │
  ├── load last 10 conversation_messages (slot-stitching context for Sonnet)
  │
  └── Sonnet agent loop (≤5 iters, ≤45s budget)
        │
        ├── system prompt: family categories + slot-stitching rule
        ├── tools: READ + DIRECT_WRITE + PROPOSE-WRITE (see §5.3)
        │
        ├── Sonnet response:
        │     ├── tool_use blocks
        │     │     ├── READ tool   → execute, feed result back, loop
        │     │     ├── DIRECT WRITE → execute, formatted reply IS the canonical reply
        │     │     └── PROPOSE WRITE → store pending_confirm, exit loop with keyboard
        │     └── text blocks → finalReply
        │
        └── post-loop:
              ├── if direct-write ran: directWriteReply OVERRIDES Sonnet's text
              ├── if no text but read-tool ran: pass tool result through
              ├── HALLUCINATION GUARD: if no direct-write but reply matches /^✅ ... ₸/
              │   ├── try parser recovery (income → debt → expense)
              │   └── if parsers can't help: honest "не получилось" + log incident
              └── save user + assistant turns to conversation_messages
```

### 5.3 Tool tiers

| Tier | Examples | Behavior |
|---|---|---|
| **READ** | `search_transactions_by_comment`, `list_recent_transactions`, `get_month_summary`, `get_top_items_by_comment`, `get_debts` | Execute immediately, feed result back to Sonnet. Result is user-ready text; if Sonnet goes silent on the next turn, we ship the result directly. |
| **DIRECT WRITE** | `log_expense`, `log_income`, `log_debt` | Execute immediately, no confirmation. Reply rendered from DB row (reply-from-result). Tool result OVERRIDES Sonnet's paraphrased text after the loop. |
| **PROPOSE WRITE** | `propose_create_goal`, `propose_set_monthly_plan`, `propose_create_categories_bulk`, `propose_rename_category`, `propose_delete_category`, `propose_merge_categories`, `propose_update_transaction_category`, `propose_delete_transaction`, `propose_contribute_to_goal`, `propose_archive_goal` | Store a `pending_confirms` row; reply with the proposal text + ✅ Да / ❌ Отмена inline keyboard. Execute on callback tap. Used for high-stakes ops (deletes, renames, monetary plans, goals). |

### 5.4 Hallucination guard + parser recovery

This is the safety net that lets us trust the LLM with intent recognition without the Akbota-class risk.

- After the agent loop ends, if **no direct-write tool ran** AND `finalReply` matches `/^\s*✅[^\n]*\d[\d\s]*\s*₸/m`, the reply is suspect.
- Parsers run as recovery in this order: `tryParseIncome` → `tryParseDebt` → `tryParseExpenses`. Order matters: expense regex matches every shape-perfect input and would steal "зарплата 500000" if it ran first.
- If a parser succeeds, the actual handler runs (`handleIncome` / `handleDebt` / `handleExpenses`) and its DB-row-formatted reply replaces the suspect text.
- If no parser matches, the user sees "🤔 Не получилось разобрать формат…" and the incident is logged via `captureError(source: 'chat:hallucination_guard', context: {user_message, sonnet_reply})` for later analysis.

### 5.5 Categorization

When a new expense is logged, the category is resolved as:

1. Look up `category_overrides` for the normalized comment (lowercase, strip digits/punct). If a per-family override matches → use it.
2. Otherwise call Sonnet with the family's category list and ask it to pick a slug. Constrained-output: must return one of the existing slugs.
3. If `slug === 'credit'`, also check active debts for a name match and decrement `remaining_amount` (or close the debt).

When the user corrects a category via `propose_update_transaction_category`, the keyword → category mapping is written to `category_overrides`, so the next similar expense routes correctly without an LLM call.

---

## 6. Tenancy and authorization

### 6.1 Routing rule

```sql
SELECT family_id FROM family_chats WHERE chat_id = $1
```

If a row exists, the message dispatches to that family. If not:
- DM with `/start invite_X` → consume invite, link chat to that family.
- Group `my_chat_member` event → if the user who added the bot owns a family, bind the group to it.
- Otherwise → reject DM with "нужно приглашение"; silent in groups.

### 6.2 Within a bound chat

Per the doc: *"Trust boundary is the chat itself, established at bind time."* Anyone in a bound group can log expenses, run queries, and tap confirm buttons. New members are auto-registered via `getOrCreateUserInFamily` on their first message — refused only if their `telegram_id` is already linked to a different family (cross-family leak protection).

### 6.3 Destructive operations **[planned]**

Currently anyone in a family can delete categories, delete old transactions, archive goals. The doc specifies these should be owner-only — not yet enforced.

### 6.4 Subscription enforcement **[planned]**

No `paid_until` checks today; access is gated by manually issued invite codes.

---

## 7. Failure modes (what we've actually hit)

| Failure | Mitigation in code today |
|---|---|
| LLM hallucinates "✅ записал" without calling tool | §5.4 hallucination guard + parser recovery |
| LLM mis-categorizes expense | User says "поменяй категорию X на Y"; `propose_update_transaction_category` writes override; future similar inputs auto-route. |
| LLM fakes summary text | DB-row-rendered replies override Sonnet's text on direct-write tool calls (`directWriteReply` win). |
| Telegram retries within window | Heuristic dedup on (family_id, amount, comment) within 10 min. |
| Webhook delivery slow (Vercel cold start, Anthropic latency) | 55s grammy timeout + 45s loop budget; user gets honest "это заняло слишком долго" instead of Telegram retry storm. |
| Forged webhook update | `X-Telegram-Bot-Api-Secret-Token` verified on every request; missing/wrong → reject. |
| Two families' members in one Telegram group | First binding wins (chat_id is PK on `family_chats`). |
| New group member tries to write | Auto-registered to the group's bound family; refused only if already linked elsewhere. |
| User pastes secret into bot **[planned]** | No PII scrubber yet — `conversation_messages` stores raw text. |
| Subscription expires mid-conversation **[planned]** | No paid_until check today. |
| Anthropic API outage | Bot returns errors; the `error_log` table captures them. No automatic degraded mode. |

---

## 8. Operations

### 8.1 Environments

| Env | Bot | DB project | Vercel target |
|---|---|---|---|
| Dev | `@islam_family_finance_dev_bot` | `rcpuvqjrtxyuvmnjandm.supabase.co` | preview, alias `family-finance-git-dev-...` |
| Prod | `@islam_family_finance_bot` | `tipoaqlwtmiawvsbdhgu.supabase.co` (new project) | production |

Both webhooks use distinct secret tokens; both bots have webhook + secret_token configured via `setWebhook`. Vercel function region = `bom1` for both.

### 8.2 Backups

- Supabase daily managed snapshots + 7-day PITR.
- Weekly `pg_dump --format=custom` via GitHub Action, stored locally with 90-day retention. Per-family restore is documented (filter on `family_id`); RTO target ~24h.

### 8.3 Smoke test

`smoke-test.ts` (in repo root) creates a fresh family in dev DB and drives `chat()` through ~15 critical regression cases (currency-suffix, contextual replies, `зафиксируй доход`, NL command misclassification, hallucination guard recovery). Run manually before any prod deploy:

```
node --import tsx --env-file .env.dev.local --env-file .env.local smoke-test.ts
```

### 8.4 Observability

- Sentry captures unhandled errors at the webhook boundary.
- `error_log` table records intentional incidents (categorize() failed-fallbacks, hallucination_guard fires, payDebt failures).
- Vercel function logs available via dashboard for ~2 hours.

There is **no structured `bot_actions_log`** **[planned]** — no per-turn audit table that records intent + tool + outcome.

### 8.5 Migration runbook

- Dev: write `supabase/migrations/NNN_*.sql`, apply via Supabase SQL editor on dev project, smoke-test.
- Prod: same SQL run on prod project's SQL editor. No CI-driven migration yet.
- Every migration must be idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) since both prod and dev get manually applied.

---

## 9. What's planned (in priority order)

| # | Item | Why | Effort |
|---|---|---|---|
| 1 | `(chat_id, telegram_message_id)` real idempotency key | Replaces brittle 10-min heuristic dedup; correct retry semantics | ~1h |
| 2 | `bot_actions_log` audit table | Visibility into what the bot is doing for paying users | ~2h |
| 3 | PII scrubber on user message text before audit/log writes | Defense vs accidentally-pasted secrets | ~30min |
| 4 | Owner-only destructive ops | Currently any family member can delete categories | ~1h |
| 5 | `paid_until` + read-only mode | Needed before first invoice-vs-access decision | ~2h |
| 6 | Eval-driven model migration (Sonnet → maybe Haiku, or alternative provider) | Right answer is data, not vibes | ~1 day |
| 7 | RLS on all domain tables | Tenant isolation by construction instead of by query discipline | ~1 day refactor |

---

## 10. What's intentionally out of scope

- Receipt OCR / image input.
- Multi-currency.
- End-user web dashboard.
- Bank integration.
- Recurring transaction auto-detection (the table exists but the ingest is not wired).
- Per-member allowlists or roles within a family.
- Multi-region deployment.
- Automated secret rotation.
