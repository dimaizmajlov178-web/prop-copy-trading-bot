import type { BotRole, BotUser } from "@/lib/models";
import { getBotUser, upsertBotUser } from "@/lib/models";

/** Telegram ID владельца сервиса. */
export const OWNER_TELEGRAM_ID = "5177702263";

export interface AccessResult {
  allowed: boolean;
  role: BotRole | null;
  user: BotUser | null;
  /** Причина отказа: unknown — пользователь не добавлен, expired — истёк срок доступа. */
  reason?: "unknown" | "expired";
}

/** Текущая дата в формате YYYY-MM-DD (UTC). */
export function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

export function isAccessExpired(user: BotUser): boolean {
  if (!user.accessExpiresAt) return false;
  return user.accessExpiresAt < todayUtc();
}

/** Дата окончания доступа через указанное число дней (UTC), включительно. */
export function addDaysUtc(days: number): string {
  const date = new Date(`${todayUtc()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}

/**
 * Сколько полных дней осталось до окончания доступа (UTC).
 * null — доступ бессрочный; 0 — истекает сегодня; отрицательное — уже истёк.
 */
export function remainingDaysUtc(expiresAt?: string): number | null {
  if (!expiresAt) return null;
  const today = new Date(`${todayUtc()}T00:00:00Z`).getTime();
  const expires = new Date(`${expiresAt}T00:00:00Z`).getTime();
  return Math.round((expires - today) / 86_400_000);
}

export function getRoleForTelegramId(telegramId: string): BotRole | null {
  return telegramId === OWNER_TELEGRAM_ID ? "owner" : null;
}

/**
 * Определяет роль и проверяет доступ пользователя.
 * Владелец определяется по фиксированному Telegram ID и автоматически создаётся в базе.
 */
export async function resolveAccess(
  telegramId: string,
  username?: string
): Promise<AccessResult> {
  const fixedRole = getRoleForTelegramId(telegramId);

  let user: BotUser | null = null;
  try {
    user = await getBotUser(telegramId);
  } catch (error) {
    console.error("Failed to load bot user:", error);
    return { allowed: false, role: null, user: null, reason: "unknown" };
  }

  if (fixedRole) {
    if (!user) {
      try {
        user = await upsertBotUser(telegramId, { username, role: fixedRole });
      } catch (error) {
        console.error("Failed to provision owner:", error);
      }
    }
    return { allowed: true, role: fixedRole, user };
  }

  if (!user) {
    return { allowed: false, role: null, user: null, reason: "unknown" };
  }

  if (isAccessExpired(user)) {
    return { allowed: false, role: null, user, reason: "expired" };
  }

  return { allowed: true, role: user.role, user };
}
