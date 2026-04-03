import Anthropic from '@anthropic-ai/sdk';
import type { CategorySlug, ParsedExpense } from '@/types';

const VALID_SLUGS: CategorySlug[] = [
  'home', 'food', 'transport', 'cafe', 'baby',
  'health', 'credit', 'personal', 'savings', 'misc',
];

const client = new Anthropic();

const TOOL_DEFINITION: Anthropic.Tool = {
  name: 'record_expense',
  description: 'Record a parsed expense from user message',
  input_schema: {
    type: 'object' as const,
    properties: {
      amount: { type: 'number', description: 'Amount in tenge (KZT)' },
      category_slug: {
        type: 'string',
        enum: VALID_SLUGS,
        description: 'Category slug',
      },
      comment: { type: 'string', description: 'Brief description (optional)', nullable: true },
      confidence: { type: 'number', description: 'Confidence 0-1 that category is correct' },
    },
    required: ['amount', 'category_slug', 'confidence'],
  },
};

const SYSTEM_PROMPT = `Ты — семейный финансовый ассистент для семьи в Казахстане. Все суммы в тенге (KZT).

Категории:
- home: Жильё (квартира, коммуналка, аренда)
- food: Продукты (магазин, еда домой)
- transport: Транспорт (такси, бензин, автобус, Yandex.GO)
- cafe: Кафе & выход (кофе, рестораны, бары, обеды вне дома)
- baby: Балапанчик (ребёнок: врачи, памперсы, игрушки)
- health: Здоровье (аптека, врачи, психолог)
- credit: Кредиты (платежи по кредитам)
- personal: Личное (стрижка, одежда, подписки, уход)
- savings: Savings (сбережения, откладываем)
- misc: Разное (подарки, непредвиденное)

Определи сумму и категорию из сообщения пользователя. Используй tool record_expense.`;

export async function parseExpenseWithClaude(message: string): Promise<ParsedExpense | null> {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20250507',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'tool', name: 'record_expense' },
      messages: [{ role: 'user', content: message }],
    });

    const toolUse = response.content.find(block => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return null;

    const input = toolUse.input as {
      amount: number;
      category_slug: string;
      comment?: string;
      confidence: number;
    };

    if (!VALID_SLUGS.includes(input.category_slug as CategorySlug)) return null;
    if (input.amount <= 0) return null;

    return {
      amount: Math.round(input.amount),
      category_slug: input.category_slug as CategorySlug,
      comment: input.comment ?? null,
      confidence: input.confidence,
    };
  } catch (error) {
    console.error('Claude API error:', error);
    return null;
  }
}
