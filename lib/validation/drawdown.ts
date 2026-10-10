import { z } from "zod";

/** Пресеты дневного лимита просадки (в процентах от счета). */
export const DRAWDOWN_LIMIT_PRESETS = [
  { label: "1%", value: "1" },
  { label: "2%", value: "2" },
  { label: "3%", value: "3" },
  { label: "5%", value: "5" },
] as const;

/**
 * Дневной лимит просадки в процентах: число от 0.1 до 100,
 * не более двух знаков после запятой; запятая допустима как разделитель.
 * Возвращает нормализованную строку с точкой (например, "2.5").
 */
export const drawdownLimitSchema = z
  .string()
  .trim()
  .min(1, "Введите лимит, например 2 или 2.5")
  .max(8, "Слишком длинное значение лимита")
  .regex(
    /^\d{1,3}([.,]\d{1,2})?$/,
    "Лимит должен быть числом от 0.1 до 100, например 2 или 2.5"
  )
  .transform((value) => value.replace(",", "."))
  .refine((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 100;
  }, "Лимит должен быть в диапазоне от 0.1 до 100");

/** Форматирует лимит для показа пользователю: "2.5" → "2,5". */
export function formatDrawdownLimit(limitPercent: string): string {
  return limitPercent.replace(".", ",");
}
