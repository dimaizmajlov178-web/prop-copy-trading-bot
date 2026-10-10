import { z } from "zod";

const telegramIdSchema = z
  .string()
  .regex(/^\d{1,20}$/, "Telegram ID должен быть числом");

const daysSchema = z.coerce
  .number()
  .int("Срок доступа должен быть целым числом дней")
  .min(1, "Срок доступа должен быть не меньше 1 дня")
  .max(3650, "Срок доступа не может превышать 3650 дней");

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName, ...args] = trimmed.split(/\s+/);
  const name = rawName.split("@")[0].toLowerCase();
  return { name, args };
}

export const addArgsSchema = z.object({
  telegramId: telegramIdSchema,
  days: daysSchema,
  tag: z
    .string()
    .trim()
    .min(1, "Тег не может быть пустым")
    .max(64, "Тег слишком длинный"),
});

export const targetArgsSchema = z.object({
  telegramId: telegramIdSchema,
});
