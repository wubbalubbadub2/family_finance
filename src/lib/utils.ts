/**
 * Format amount in Kazakh convention: "15 000 ₸"
 */
export function formatTenge(amount: number): string {
  return amount.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₸';
}

/**
 * Get current date in Asia/Almaty timezone as YYYY-MM-DD
 */
export function todayAlmaty(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Almaty' });
}

/**
 * Get current year and month in Almaty timezone
 */
export function currentMonthAlmaty(): { year: number; month: number } {
  const now = new Date();
  const almaty = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
  return { year: almaty.getFullYear(), month: almaty.getMonth() + 1 };
}

/**
 * Format date for display: "3 апр"
 */
export function formatDateShort(dateStr: string): string {
  const months = [
    'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
  ];
  const d = new Date(dateStr);
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

/**
 * Month name in Russian
 */
export function monthNameRu(month: number): string {
  const names = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];
  return names[month - 1] ?? '';
}
