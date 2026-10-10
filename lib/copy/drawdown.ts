import { randomUUID } from "crypto";
import { isDatabaseAvailable } from "@/lib/db";
import {
  deleteDrawdownState,
  getDrawdownSettings,
  getDrawdownState,
  listBotUsers,
  listUpscaleBindings,
  putDrawdownState,
  type DrawdownBreachState,
  type DrawdownSettings,
} from "@/lib/models";
import { isAccessExpired } from "@/lib/telegram/access";
import { decryptSecret } from "@/lib/telegram/crypto";
import { notifyUser } from "@/lib/telegram/notify";
import {
  UpscaleApiError,
  closeAllPositions,
  fetchRiskStatuses,
} from "@/lib/upscale/client";
import { formatFp9 } from "@/lib/upscale/fp9";
import { decimalStringToRatio } from "./volume";

export interface DrawdownCheckCycleStats {
  accountsChecked: number;
  triggered: number;
  positionsClosed: number;
  failures: number;
  errors: string[];
}

/** Текущий торговый день в формате YYYY-MM-DD (UTC). */
export function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

function isValidFp9(value: string | null | undefined): value is string {
  return !!value && /^-?\d+$/.test(value.trim());
}

function describeError(error: unknown): string {
  if (error instanceof UpscaleApiError) return error.userMessage;
  console.error("Drawdown check internal error:", error);
  return "Внутренняя ошибка.";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Достигла ли просадка дневного лимита? Чистый расчёт над строками fp9
 * в BigInt, без плавающей точки: убыток = dayStartEquity − currentEquity;
 * срабатывание, когда loss / dayStartEquity ≥ limitPercent / 100.
 */
export function isDrawdownLimitBreached(
  dayStartEquityFp9: string | null | undefined,
  currentEquityFp9: string | null | undefined,
  limitPercent: string
): boolean {
  if (!isValidFp9(dayStartEquityFp9) || !isValidFp9(currentEquityFp9)) {
    return false;
  }

  const ratio = decimalStringToRatio(limitPercent);
  if (!ratio) return false;

  const dayStart = BigInt(dayStartEquityFp9.trim());
  if (dayStart <= 0n) return false;

  const loss = dayStart - BigInt(currentEquityFp9.trim());
  if (loss <= 0n) return false;

  return loss * 100n * ratio.denominator >= dayStart * ratio.numerator;
}

/**
 * Проверяет, заблокировано ли открытие новых копий на счете из-за
 * срабатывания дневного лимита просадки. Состояние привязано к торговому
 * дню (UTC): на следующий день срабатывание сбрасывается и копирование
 * возобновляется.
 */
export async function isCopyBlockedByDrawdown(
  telegramId: string,
  accountId: string
): Promise<boolean> {
  const state = await getDrawdownState(telegramId, accountId);

  if (!state) return false;

  if (state.tradingDay !== todayUtc()) {
    await deleteDrawdownState(telegramId, accountId).catch(() => {});
    return false;
  }

  return true;
}

/** Отправляет участнику уведомление о срабатывании лимита. */
async function notifyBreach(
  telegramId: string,
  state: DrawdownBreachState
): Promise<void> {
  const lines = [
    "🛑 <b>Достигнут дневной лимит просадки</b>",
    "",
    `Счет: <code>${escapeHtml(state.accountId)}</code>`,
    `Эквити на начало дня: <b>${formatFp9(state.dayStartEquityFp9)}</b> USD`,
    `Текущее эквити: <b>${formatFp9(state.currentEquityFp9)}</b> USD`,
    `Дневной лимит: <b>${escapeHtml(state.limitPercent.replace(".", ","))}%</b>`,
    "",
    "До конца дня новые копии позиций на этом счете открываться не будут.",
    "Завтра копирование возобновится автоматически.",
  ];

  if (state.closePositions) {
    lines.push(
      state.positionsClosed
        ? "Открытые позиции счета закрыты по рынку (close-all)."
        : "Позиции счета будут закрыты по рынку (close-all)."
    );
  }

  await notifyUser(telegramId, lines.join("\n"));
}

/**
 * Отмечает срабатывание лимита и, если включено автозакрытие, закрывает все
 * позиции счета через POST /positions/{accountId}/close-all.
 */
async function triggerBreach(
  telegramId: string,
  accountId: string,
  settings: DrawdownSettings,
  dayStartEquityFp9: string | null,
  currentEquityFp9: string | null,
  apiKey: string,
  stats: DrawdownCheckCycleStats
): Promise<void> {
  const now = new Date().toISOString();

  const state: DrawdownBreachState = {
    telegramId,
    accountId,
    tradingDay: todayUtc(),
    limitPercent: settings.dailyLimitPercent as string,
    dayStartEquityFp9,
    currentEquityFp9,
    closePositions: settings.closePositionsOnBreach,
    positionsClosed: false,
    triggeredAt: now,
    updatedAt: now,
  };
  await putDrawdownState(state);
  stats.triggered++;

  await notifyBreach(telegramId, state);

  if (!settings.closePositionsOnBreach) return;

  try {
    await closeAllPositions(apiKey, accountId, randomUUID());
    state.positionsClosed = true;
    state.updatedAt = new Date().toISOString();
    await putDrawdownState(state);
    stats.positionsClosed++;
  } catch (error) {
    stats.failures++;
    stats.errors.push(
      `Счет ${accountId}: не удалось закрыть позиции при срабатывании лимита: ${describeError(error)}`
    );
  }
}

/**
 * Периодическая проверка дневного лимита просадки: для каждого участника
 * с заданным лимитом читает GET /accounts/risk-status по ключам его
 * дополнительных счетов (снимки по всем счетам ключа одним запросом) и
 * сравнивает текущее эквити с dayStartEquity. При достижении лимита
 * фиксирует срабатывание в DynamoDB с привязкой к торговому дню,
 * уведомляет участника и, по желанию участника, закрывает открытые
 * позиции счета (POST /positions/{accountId}/close-all).
 */
export async function runDrawdownCheckCycle(): Promise<DrawdownCheckCycleStats> {
  const stats: DrawdownCheckCycleStats = {
    accountsChecked: 0,
    triggered: 0,
    positionsClosed: 0,
    failures: 0,
    errors: [],
  };

  try {
    if (!(await isDatabaseAvailable())) {
      stats.errors.push("База данных недоступна — проверка лимита пропущена.");
      return stats;
    }
  } catch {
    stats.errors.push("База данных недоступна — проверка лимита пропущена.");
    return stats;
  }

  let users;

  try {
    users = await listBotUsers();
  } catch (error) {
    stats.errors.push(
      `Не удалось получить пользователей: ${describeError(error)}`
    );
    return stats;
  }

  const bindingsByUser = new Map<
    string,
    Awaited<ReturnType<typeof listUpscaleBindings>>
  >();

  for (const user of users) {
    if (isAccessExpired(user)) continue;

    const telegramId = user.telegramId;

    let settings: DrawdownSettings | null;

    try {
      settings = await getDrawdownSettings(telegramId);
    } catch (error) {
      stats.errors.push(
        `Участник ${telegramId}: не удалось прочитать настройки лимита: ${describeError(error)}`
      );
      continue;
    }

    if (!settings?.dailyLimitPercent) continue;

    let bindings = bindingsByUser.get(telegramId);

    if (!bindings) {
      try {
        bindings = await listUpscaleBindings(telegramId);
        bindingsByUser.set(telegramId, bindings);
      } catch (error) {
        stats.errors.push(
          `Участник ${telegramId}: не удалось получить привязки счетов: ${describeError(error)}`
        );
        continue;
      }
    }

    const additionalBindings = bindings.filter(
      (binding) => binding.kind === "additional" && binding.accounts.length > 0
    );

    for (const binding of additionalBindings) {
      let apiKey: string;

      try {
        apiKey = decryptSecret(binding.apiKeyEncrypted);
      } catch {
        stats.errors.push(
          `Участник ${telegramId}: не удалось расшифровать API-ключ.`
        );
        continue;
      }

      let snapshots: Awaited<ReturnType<typeof fetchRiskStatuses>>;

      try {
        snapshots = await fetchRiskStatuses(apiKey);
      } catch (error) {
        stats.errors.push(
          `Участник ${telegramId}: не удалось получить снимки риска: ${describeError(error)}`
        );
        continue;
      }

      for (const account of binding.accounts) {
        if (!account.apiTrading) continue;

        const snapshot = snapshots.find(
          (item) => item.accountId === account.accountId
        );

        if (!snapshot) continue;

        stats.accountsChecked++;

        try {
          const existing = await getDrawdownState(
            telegramId,
            account.accountId
          );

          if (existing && existing.tradingDay === todayUtc()) {
            if (settings.closePositionsOnBreach && !existing.positionsClosed) {
              await closeAllPositions(apiKey, account.accountId, randomUUID());
              existing.positionsClosed = true;
              existing.updatedAt = new Date().toISOString();
              await putDrawdownState(existing);
              stats.positionsClosed++;
            }
            continue;
          }

          const breached = isDrawdownLimitBreached(
            snapshot.dayStartEquityFp9,
            snapshot.currentEquityFp9,
            settings.dailyLimitPercent
          );

          if (!breached) continue;

          await triggerBreach(
            telegramId,
            account.accountId,
            settings,
            snapshot.dayStartEquityFp9,
            snapshot.currentEquityFp9,
            apiKey,
            stats
          );
        } catch (error) {
          stats.failures++;
          stats.errors.push(
            `Участник ${telegramId}, счет ${account.accountId}: ошибка проверки лимита: ${describeError(error)}`
          );
        }
      }
    }
  }

  return stats;
}
