/**
 * Все вычисления объёмов копий ведутся над строками fp9 (значение × 10⁹)
 * в BigInt — без плавающей точки. Деление целочисленное с округлением вниз.
 */
export interface Fp9Ratio {
  numerator: bigint;
  denominator: bigint;
}

/**
 * Разбирает десятичную строку коэффициента ("2", "1", "0.5", "1.25")
 * в отношение натуральных чисел. Возвращает null, если строка не является
 * положительным числом не более чем с девятью знаками после точки.
 */
export function decimalStringToRatio(value: string): Fp9Ratio | null {
  const trimmed = value.trim();

  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) return null;

  const [intPart, fracPart = ""] = trimmed.split(".");
  const paddedFrac = fracPart.padEnd(9, "0");

  const numerator = BigInt(intPart + paddedFrac);
  const denominator = 1_000_000_000n;

  if (numerator <= 0n) return null;

  return { numerator, denominator };
}

/**
 * Считает объём копии в USD (строка fp9): объём позиции трейдера ×
 * (размер счета подписчика / размер счета трейдера) × коэффициент подписки.
 * Округление вниз. Возвращает null, если данные некорректны или результат 0.
 */
export function computeCopyAmountFp9(
  traderAmountFp9: string,
  subscriberAccountSizeFp9: string,
  traderAccountSizeFp9: string,
  coefficient: string
): string | null {
  const ratio = decimalStringToRatio(coefficient);

  if (!ratio) return null;
  if (!/^\d+$/.test(traderAmountFp9.trim())) return null;
  if (!/^\d+$/.test(subscriberAccountSizeFp9.trim())) return null;
  if (!/^\d+$/.test(traderAccountSizeFp9.trim())) return null;

  const traderAmount = BigInt(traderAmountFp9.trim());
  const subscriberSize = BigInt(subscriberAccountSizeFp9.trim());
  const traderSize = BigInt(traderAccountSizeFp9.trim());

  if (traderSize <= 0n) return null;

  const numerator = traderAmount * subscriberSize * ratio.numerator;
  const denominator = traderSize * ratio.denominator;
  const result = numerator / denominator;

  return result > 0n ? result.toString() : null;
}

/**
 * Разность fp9-значений (a − b). Отрицательный результат невозможен:
 * при a < b возвращается "0".
 */
export function fp9DeltaFp9(a: string, b: string): string | null {
  if (!/^\d+$/.test(a.trim()) || !/^\d+$/.test(b.trim())) return null;
  const delta = BigInt(a.trim()) - BigInt(b.trim());
  return (delta > 0n ? delta : 0n).toString();
}

/** Сравнение неотрицательных fp9-строк: true, если a > b. */
export function isFp9Greater(a: string, b: string): boolean {
  if (!/^\d+$/.test(a.trim()) || !/^\d+$/.test(b.trim())) return false;
  return BigInt(a.trim()) > BigInt(b.trim());
}
