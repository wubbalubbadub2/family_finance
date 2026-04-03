import type { CategorySlug, ParsedExpense } from '@/types';

// Keyword-to-category mapping for common Russian/Kazakh expense terms
const KEYWORD_MAP: Record<string, CategorySlug> = {
  // Transport
  'такси': 'transport',
  'taxi': 'transport',
  'yandex': 'transport',
  'яндекс': 'transport',
  'бензин': 'transport',
  'автобус': 'transport',
  'avtobys': 'transport',
  'каршеринг': 'transport',
  'газель': 'transport',

  // Food
  'продукты': 'food',
  'магазин': 'food',
  'магнум': 'food',
  'magnum': 'food',
  'арнау': 'food',
  'small': 'food',
  'мясо': 'food',
  'овощи': 'food',
  'фрукты': 'food',
  'молоко': 'food',
  'хлеб': 'food',

  // Cafe
  'кофе': 'cafe',
  'coffee': 'cafe',
  'кафе': 'cafe',
  'ресторан': 'cafe',
  'обед': 'cafe',
  'ужин': 'cafe',
  'бар': 'cafe',
  'пицца': 'cafe',
  'доставка еды': 'cafe',

  // Home
  'аренда': 'home',
  'квартира': 'home',
  'коммуналка': 'home',
  'квартплата': 'home',
  'газ': 'home',
  'свет': 'home',
  'электричество': 'home',
  'вода': 'home',
  'интернет': 'home',

  // Health
  'аптека': 'health',
  'pharma': 'health',
  'врач': 'health',
  'больница': 'health',
  'лекарства': 'health',
  'клиника': 'health',
  'психолог': 'health',
  'стоматолог': 'health',

  // Baby
  'памперсы': 'baby',
  'балапан': 'baby',
  'балапанчик': 'baby',
  'педиатр': 'baby',
  'детский': 'baby',
  'игрушки': 'baby',
  'смесь': 'baby',

  // Credit
  'кредит': 'credit',
  'халык': 'credit',
  'бцк': 'credit',
  'центркредит': 'credit',
  'ипотека': 'credit',
  'рассрочка': 'credit',
  'дудар': 'credit',

  // Personal
  'стрижка': 'personal',
  'одежда': 'personal',
  'шугаринг': 'personal',
  'маникюр': 'personal',
  'подписка': 'personal',
  'netflix': 'personal',
  'spotify': 'personal',
  'youtube': 'personal',
  'барбершоп': 'personal',

  // Savings
  'сбережения': 'savings',
  'отложить': 'savings',
  'savings': 'savings',
  'накопления': 'savings',
  'депозит': 'savings',

  // Misc
  'подарок': 'misc',
  'цветы': 'misc',
  'flowers': 'misc',
};

/**
 * Try to parse an expense from a free-form Russian message using regex.
 * Returns null if no pattern matches confidently.
 *
 * Supported patterns:
 *   "такси 2500"
 *   "2500 такси"
 *   "кофе 1800 жаным"
 *   "балапанчик педиатр 15000"
 */
export function parseExpenseWithRegex(message: string): ParsedExpense | null {
  const text = message.toLowerCase().trim();

  // Extract amount: find a number (with optional spaces as thousands separators)
  const amountMatch = text.match(/(\d[\d\s]*\d|\d+)/);
  if (!amountMatch) return null;

  const amount = parseInt(amountMatch[1].replace(/\s/g, ''), 10);
  if (amount <= 0 || amount > 100_000_000) return null;

  // Remove the amount from text to search for keywords
  const textWithoutAmount = text.replace(amountMatch[0], '').trim();
  const words = textWithoutAmount.split(/\s+/).filter(Boolean);

  // Try to match a keyword
  for (const word of words) {
    for (const [keyword, slug] of Object.entries(KEYWORD_MAP)) {
      if (word.includes(keyword) || keyword.includes(word)) {
        // Build comment from remaining words (excluding the matched keyword)
        const commentWords = words.filter(w => w !== word);
        const comment = commentWords.length > 0 ? commentWords.join(' ') : null;

        return {
          amount,
          category_slug: slug,
          comment,
          confidence: 0.9,
        };
      }
    }
  }

  // If only a number was sent, can't categorize
  if (words.length === 0) return null;

  // Unknown keywords — return low confidence
  return {
    amount,
    category_slug: 'misc',
    comment: textWithoutAmount || null,
    confidence: 0.3,
  };
}
