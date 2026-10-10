import { z } from "zod";

/** Пресеты коэффициентов копирования (соотношение копия : пропорция счетов). */
export const COEFFICIENT_PRESETS = [
  { label: "2:1", value: "2" },
  { label: "1:1", value: "1" },
  { label: "0,5:1", value: "0.5" },
] as const;

/**
 * Коэффициент копирования: положительное число от 0,01 до 100,
 * не более двух знаков после запятой; запятая допустима как разделитель.
 * Возвращает нормализованную строку с точкой (например, "0.5").
 */
export const subscriptionCoefficientSchema = z
  .string()
  .trim()
  .min(1, "Введите коэффициент, например 1.5")
  .max(8, "Слишком длинное значение коэффициента")
  .regex(
    /^\d{1,3}([.,]\d{1,2})?$/,
    "Коэффициент должен быть положительным числом, например 2, 1, 0.5 или 1.25"
  )
  .transform((value) => value.replace(",", "."))
  .refine((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 100;
  }, "Коэффициент должен быть в диапазоне от 0.01 до 100");

/** Форматирует коэффициент для показа пользователю: "0.5" → "0,5". */
export function formatCoefficient(coefficient: string): string {
  return coefficient.replace(".", ",");
}
