/**
 * Get the last day of a given year/month as YYYY-MM-DD string.
 * Uses UTC arithmetic so server timezone doesn't matter.
 */
export function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Number of days in a given year/month (calendar only, timezone-independent).
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

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
