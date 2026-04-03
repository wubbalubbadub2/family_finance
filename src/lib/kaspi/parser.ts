import type { TransactionType } from '@/types';

export interface KaspiTransaction {
  date: string;         // YYYY-MM-DD
  amount: number;       // absolute value in whole tenge
  type: TransactionType;
  operation: string;    // Покупка, Перевод, Пополнение, etc.
  details: string;      // merchant name or transfer recipient
}

// Known internal transfer patterns (not real expenses/income)
const INTERNAL_PATTERNS = [
  'на kaspi депозит',
  'с kaspi депозит',
  'со своего счета в kaspi pay',
  'на свой счет в kaspi pay',
  'с kaspi pay',
  'на kaspi pay',
];

/**
 * Parse Kaspi Bank PDF text into structured transactions.
 * Ported from analyzeStatement.py
 *
 * Expected text line format from Kaspi PDF:
 *   DD.MM.YY  ± X XXX,XX ₸  Operation  Details
 */
export function parseKaspiText(text: string, internalContacts: string[] = []): KaspiTransaction[] {
  const transactions: KaspiTransaction[] = [];
  const lines = text.split('\n');

  // Regex for a transaction line: date, amount, then operation and details
  const lineRegex = /^(\d{2}\.\d{2}\.\d{2})\s+([-+]?\s*[\d\s]+[,.]?\d*)\s*₸?\s+(\S+)\s*(.*)/;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(lineRegex);
    if (!match) continue;

    const [, dateStr, amountStr, operation, details] = match;

    // Parse date (DD.MM.YY -> YYYY-MM-DD)
    const [day, month, year] = dateStr.split('.');
    const fullYear = parseInt(year, 10) < 50 ? `20${year}` : `19${year}`;
    const date = `${fullYear}-${month}-${day}`;

    // Parse amount
    const cleanAmount = amountStr.replace(/\s/g, '').replace(',', '.');
    const numericAmount = parseFloat(cleanAmount);
    if (isNaN(numericAmount)) continue;

    const absAmount = Math.round(Math.abs(numericAmount));
    if (absAmount === 0) continue;

    // Determine transaction type
    const detailsLower = details.toLowerCase();
    const isInternal =
      INTERNAL_PATTERNS.some(p => detailsLower.includes(p)) ||
      internalContacts.some(c => detailsLower.includes(c.toLowerCase()));

    let type: TransactionType;
    if (isInternal) {
      type = 'internal';
    } else if (numericAmount > 0) {
      type = 'income';
    } else {
      type = 'expense';
    }

    transactions.push({
      date,
      amount: absAmount,
      type,
      operation: operation.trim(),
      details: details.trim(),
    });
  }

  return transactions;
}

// Merchant-to-category mapping based on known Kaspi merchants
// (derived from analyzeStatement.py and real bank statement data)
const MERCHANT_CATEGORY_HINTS: Record<string, string> = {
  // Food
  'магнум': 'food',
  'magnum': 'food',
  'арнау': 'food',
  'arnau': 'food',
  'delmanova': 'food',
  'interfood': 'food',
  'интерфуд': 'food',
  'f market': 'food',
  'isa food': 'food',
  'small': 'food',

  // Transport
  'yandex.go': 'transport',
  'avtobys': 'transport',
  'avtobas': 'transport',

  // Cafe
  'community': 'cafe',
  'coffee': 'cafe',
  'ресторан': 'cafe',
  'zeytuni': 'cafe',

  // Health
  'аптека': 'health',
  'pharma': 'health',
  'фарм': 'health',
  'айлико': 'health',
  'альфа-мед': 'health',

  // Personal
  'wildberries': 'personal',
  'tobacco': 'personal',
  'highvill': 'personal',
  'ar-lin': 'personal',
  'цветы': 'misc',
  'flowers': 'misc',
  'ananas': 'misc',
  'баня': 'misc',
  'орловские': 'misc',
};

/**
 * Try to guess a category slug for a Kaspi merchant name
 */
export function guessMerchantCategory(details: string): string | null {
  const lower = details.toLowerCase();
  for (const [pattern, slug] of Object.entries(MERCHANT_CATEGORY_HINTS)) {
    if (lower.includes(pattern)) return slug;
  }
  return null;
}
