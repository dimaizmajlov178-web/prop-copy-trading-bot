/**
 * Все числа UpScale API — необработанные строки fp9 (значение × 10⁹).
 * Чтение и преобразование только через BigInt, без плавающей точки.
 */
const FP9_SCALE = 1_000_000_000n;

/**
 * Преобразует строку fp9 в читаемое десятичное представление.
 * Возвращает null, если значение отсутствует или не является целым числом fp9.
 */
export function fp9ToDecimalString(
  raw: string | number | null | undefined
): string | null {
  if (raw === null || raw === undefined) return null;

  const trimmed = String(raw).trim();

  if (!/^-?\d+$/.test(trimmed)) return null;

  const value = BigInt(trimmed);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = (abs / FP9_SCALE).toString();
  const fracPart = (abs % FP9_SCALE)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");

  const sign = negative ? "-" : "";
  const magnitude = fracPart ? `${intPart}.${fracPart}` : intPart;

  if (value === 0n) return "0";

  return `${sign}${magnitude}`;
}

/** Добавляет разделители тысяч к целой части строки. */
export function groupThousands(value: string): string {
  const [intPart, fracPart] = value.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fracPart ? `${grouped}.${fracPart}` : grouped;
}

/** Форматирует fp9-значение для отображения в чате («12 345.678912345» или «—»). */
export function formatFp9(raw: string | number | null | undefined): string {
  const decimal = fp9ToDecimalString(raw);
  return decimal === null ? "—" : groupThousands(decimal);
}

/**
 * Форматирует винрейт из fp9 в проценты.
 * Значения 0…1 (×10⁹) трактуются как доля и умножаются на 100,
 * большие значения считаются уже заданными в процентах.
 */
export function formatPercentFp9(
  raw: string | number | null | undefined
): string {
  const trimmed = raw === null || raw === undefined ? "" : String(raw).trim();

  if (!/^-?\d+$/.test(trimmed)) return "—";

  const value = BigInt(trimmed);
  const isFraction = value >= 0n && value <= FP9_SCALE;
  const percent = isFraction ? value * 100n : value;
  const decimal = fp9ToDecimalString(percent.toString());

  return decimal === null ? "—" : `${groupThousands(decimal)}%`;
}

/** Форматирует среднее время удержания (fp9-секунды) в читаемый вид («2 ч 15 мин»). */
export function formatHoldTimeFp9(
  raw: string | number | null | undefined
): string {
  const trimmed = raw === null || raw === undefined ? "" : String(raw).trim();

  if (!/^-?\d+$/.test(trimmed)) return "—";

  const seconds = BigInt(trimmed) / FP9_SCALE;

  if (seconds <= 0n) return "менее минуты";

  const days = seconds / 86_400n;
  const hours = (seconds % 86_400n) / 3_600n;
  const minutes = (seconds % 3_600n) / 60n;

  const parts: string[] = [];
  if (days > 0n) parts.push(`${days} д`);
  if (hours > 0n) parts.push(`${hours} ч`);
  if (minutes > 0n) parts.push(`${minutes} мин`);

  return parts.length > 0 ? parts.join(" ") : "менее минуты";
}

/** Форматирует PnL (fp9, USD) со знаком: «+12.5», «−3.2» или «—». */
export function formatSignedFp9(
  raw: string | number | null | undefined
): string {
  const decimal = fp9ToDecimalString(raw);
  if (decimal === null) return "—";
  if (decimal === "0" || decimal === "-0") return "±0";

  return decimal.startsWith("-")
    ? `−${groupThousands(decimal.slice(1))}`
    : `+${groupThousands(decimal)}`;
}
