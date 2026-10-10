import { z } from "zod";
import type { InlineKeyboardMarkup } from "./api";
import { answerCallbackQuery, editMessageText, sendMessage } from "./api";
import { decryptSecret } from "./crypto";
import { formatCoefficient } from "@/lib/validation/subscriptions";
import { fetchAccountStats } from "@/lib/upscale/client";
import {
  formatFp9,
  formatHoldTimeFp9,
  formatPercentFp9,
  formatSignedFp9,
} from "@/lib/upscale/fp9";
import {
  countTraderSubscribers,
  getTraderStats,
  getTraderSubscription,
  listBotUsers,
  listTradesByTrader,
  listUpscaleBindings,
  putTraderStats,
  type BotUser,
  type Trade,
  type TraderStats,
} from "@/lib/models";

/** Префикс callback-дат раздела «Активные трейдеры». */
export const CALLBACK_TRADERS_PREFIX = "traders:";

const STATS_TTL_MS = 60_000;

const traderIdSchema = z.string().regex(/^\d{1,20}$/);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function backToTradersRow(): InlineKeyboardMarkup["inline_keyboard"][number] {
  return [{ text: "⬅️ К списку трейдеров", callback_data: "traders:list" }];
}

function backToMenuRow(): InlineKeyboardMarkup["inline_keyboard"][number] {
  return [{ text: "⬅️ В главное меню", callback_data: "menu" }];
}

function displayName(trader: BotUser): string {
  return trader.tag ?? trader.username ?? `ID ${trader.telegramId}`;
}

function pluralize(
  count: number,
  one: string,
  few: string,
  many: string
): string {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatStatsLine(stats: TraderStats | null): string {
  const count = stats?.positionsCount ?? 0;

  if (!stats?.hasStats || count <= 0) return "сделок ещё нет";

  return `${count} ${pluralize(count, "сделка", "сделки", "сделок")}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`,
  ].join(" ");
}

function hasAnyStats(stats: UpscaleStatsShape): boolean {
  return (
    (stats.positionsCount ?? 0) > 0 ||
    stats.winRateFp9 !== null ||
    stats.riskRewardRatioFp9 !== null ||
    stats.avgPositionHoldTimeFp9 !== null ||
    stats.topAsset !== null
  );
}

interface UpscaleStatsShape {
  positionsCount: number | null;
  winRateFp9: string | null;
  riskRewardRatioFp9: string | null;
  avgPositionHoldTimeFp9: string | null;
  topAsset: string | null;
}

async function getTraders(): Promise<BotUser[]> {
  const users = await listBotUsers();

  return users
    .filter((user) => user.role === "trader")
    .sort((a, b) => displayName(a).localeCompare(displayName(b), "ru"));
}

/**
 * Загружает свежую статистику GET /accounts/{accountId}/stats по основному
 * счету трейдера и сохраняет снимок в DynamoDB. Возвращает null, если у
 * трейдера нет привязанного основного счета или запрос выполнить не удалось.
 */
async function refreshTraderStats(
  trader: BotUser
): Promise<TraderStats | null> {
  const bindings = await listUpscaleBindings(trader.telegramId);
  const primary = bindings.find((binding) => binding.kind === "primary");

  if (!primary || primary.accounts.length === 0) return null;

  const account =
    primary.accounts.find((item) => item.apiTrading) ?? primary.accounts[0];

  let apiKey: string;

  try {
    apiKey = decryptSecret(primary.apiKeyEncrypted);
  } catch (error) {
    console.error("Failed to decrypt trader API key:", error);
    return null;
  }

  const fresh = await fetchAccountStats(apiKey, account.accountId);
  const now = new Date().toISOString();
  const cached = await getTraderStats(trader.telegramId);

  return putTraderStats({
    traderTelegramId: trader.telegramId,
    primaryAccountId: account.accountId,
    positionsCount: fresh.positionsCount,
    winRateFp9: fresh.winRateFp9,
    riskRewardRatioFp9: fresh.riskRewardRatioFp9,
    avgPositionHoldTimeFp9: fresh.avgPositionHoldTimeFp9,
    topAsset: fresh.topAsset,
    hasStats: hasAnyStats(fresh),
    // Агрегаты скопированных сделок ведутся ботом — сохраняем их
    // при обновлении снимка API-статистики.
    botTradesCount: cached?.botTradesCount,
    botWins: cached?.botWins,
    botLosses: cached?.botLosses,
    botAvgRrFp9: cached?.botAvgRrFp9 ?? null,
    botAvgHoldTimeFp9: cached?.botAvgHoldTimeFp9 ?? null,
    botTopAsset: cached?.botTopAsset ?? null,
    fetchedAt: now,
    updatedAt: now,
  });
}

async function refreshTraderStatsSafe(
  trader: BotUser
): Promise<TraderStats | null> {
  try {
    return await refreshTraderStats(trader);
  } catch (error) {
    console.error("Failed to refresh trader stats:", error);
    return null;
  }
}

async function loadTraderStats(trader: BotUser): Promise<TraderStats | null> {
  const cached = await getTraderStats(trader.telegramId);
  const isFresh =
    cached !== null && Date.now() - Date.parse(cached.fetchedAt) < STATS_TTL_MS;

  if (isFresh) return cached;

  const refreshed = await refreshTraderStatsSafe(trader);
  return refreshed ?? cached;
}

export async function buildTradersScreen(): Promise<{
  text: string;
  keyboard: InlineKeyboardMarkup;
}> {
  const traders = await getTraders();

  if (traders.length === 0) {
    return {
      text: [
        "<b>📈 Активные трейдеры</b>",
        "",
        "Активных трейдеров пока нет. Загляните позже.",
      ].join("\n"),
      keyboard: { inline_keyboard: [backToMenuRow()] },
    };
  }

  const lines: string[] = [
    "<b>📈 Активные трейдеры</b>",
    "",
    "Трейдеры-сигнальщики сервиса. Нажмите на трейдера, чтобы открыть карточку со статистикой.",
    "",
  ];
  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };

  for (let index = 0; index < traders.length; index++) {
    const trader = traders[index];
    const stats = await getTraderStats(trader.telegramId);

    lines.push(
      `${index + 1}. <b>${escapeHtml(displayName(trader))}</b>`,
      `     ${formatStatsLine(stats)}`
    );

    keyboard.inline_keyboard.push([
      {
        text: `📈 ${displayName(trader)}`,
        callback_data: `traders:view:${trader.telegramId}`,
      },
    ]);
  }

  keyboard.inline_keyboard.push([
    { text: "🔄 Обновить статистику", callback_data: "traders:refresh" },
  ]);
  keyboard.inline_keyboard.push(backToMenuRow());

  return { text: lines.join("\n"), keyboard };
}

function formatTradeLine(index: number, trade: Trade): string {
  const asset = escapeHtml(trade.asset ?? trade.marketId ?? "—");
  const side =
    trade.side === "sell" ? "продажа" : trade.side === "buy" ? "покупка" : "—";
  const pnl = formatSignedFp9(trade.pnlFp9);
  const hold = trade.holdTimeSecFp9
    ? ` · ${formatHoldTimeFp9(trade.holdTimeSecFp9)}`
    : "";

  return `${index}. <b>${asset}</b> ${escapeHtml(side)}: <b>${pnl} USD</b>${hold}`;
}

async function buildBotTradesSection(
  traderTelegramId: string
): Promise<string[]> {
  const trades = await listTradesByTrader(traderTelegramId, 5).catch(() => []);

  if (trades.length === 0) {
    return [
      "",
      "🤖 <b>Копитрейдинг (бот)</b>",
      "",
      "Скопированных сделок ещё нет.",
    ];
  }

  const wins = trades.filter((trade) => trade.result === "win").length;
  const losses = trades.filter((trade) => trade.result === "loss").length;

  return [
    "",
    "🤖 <b>Копитрейдинг (бот)</b>",
    "",
    `Последние скопированные сделки: ${wins} прибыльных / ${losses} убыточных`,
    ...trades.map((trade, index) => formatTradeLine(index + 1, trade)),
  ];
}

async function buildTraderCard(
  trader: BotUser,
  viewerTelegramId: string
): Promise<{
  text: string;
  keyboard: InlineKeyboardMarkup;
}> {
  const [stats, copiers, viewerSubscription] = await Promise.all([
    loadTraderStats(trader),
    countTraderSubscribers(trader.telegramId).catch(() => 0),
    getTraderSubscription(viewerTelegramId, trader.telegramId).catch(
      () => null
    ),
  ]);
  const lines: string[] = [
    "<b>📈 Карточка трейдера</b>",
    "",
    `Ник: <b>${escapeHtml(displayName(trader))}</b>`,
  ];

  if (!stats) {
    lines.push(
      "",
      "⚠️ У трейдера не привязан основной счет, статистика недоступна."
    );
  } else if (!stats.hasStats) {
    lines.push(
      "",
      "📭 Сделок ещё нет — статистика появится после закрытия первой сделки."
    );
  } else {
    const count = stats.positionsCount ?? 0;

    lines.push(
      `Сделок: <b>${count}</b>`,
      `Топ-актив: <b>${stats.topAsset ? escapeHtml(stats.topAsset) : "—"}</b>`,
      `Винрейт: <b>${formatPercentFp9(stats.winRateFp9)}</b>`,
      `Средний RR: <b>${formatFp9(stats.riskRewardRatioFp9)}</b>`,
      `Среднее время удержания: <b>${formatHoldTimeFp9(stats.avgPositionHoldTimeFp9)}</b>`
    );
  }

  const copiersLabel = `${copiers} ${pluralize(
    copiers,
    "участник",
    "участника",
    "участников"
  )}`;
  lines.push(`Копируют: <b>${copiersLabel}</b>`);

  if (stats) {
    lines.push("", `Обновлено: ${formatDateTime(stats.fetchedAt)}`);
  }

  lines.push(...(await buildBotTradesSection(trader.telegramId)));

  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        viewerSubscription
          ? [
              {
                text: `⚙️ Моя подписка ${escapeHtml(
                  formatCoefficient(viewerSubscription.coefficient)
                )}:1`,
                callback_data: `subs:set:${trader.telegramId}`,
              },
              {
                text: "✖️ Отписаться",
                callback_data: `subs:unsub:${trader.telegramId}`,
              },
            ]
          : [
              {
                text: "🔗 Подписаться",
                callback_data: `subs:set:${trader.telegramId}`,
              },
            ],
        [
          {
            text: "🔄 Обновить статистику",
            callback_data: `traders:refresh:${trader.telegramId}`,
          },
        ],
        backToTradersRow(),
        backToMenuRow(),
      ],
    },
  };
}

/**
 * Обрабатывает callback-запросы раздела «Активные трейдеры».
 * Возвращает true, если callback относится к разделу.
 */
export async function handleTradersCallback(
  token: string,
  chatId: number,
  telegramId: string,
  messageId: number | undefined,
  callbackQueryId: string,
  data: string
): Promise<boolean> {
  if (!data.startsWith(CALLBACK_TRADERS_PREFIX)) return false;

  const action = data.slice(CALLBACK_TRADERS_PREFIX.length);
  let alert: string | undefined;

  try {
    if (action === "list") {
      await renderScreen(token, chatId, messageId, await buildTradersScreen());
      return true;
    }

    if (action === "refresh") {
      const traders = await getTraders();

      for (const trader of traders) {
        await refreshTraderStatsSafe(trader);
      }

      await renderScreen(token, chatId, messageId, await buildTradersScreen());
      alert = "Статистика обновлена";
      return true;
    }

    const targetId = action.startsWith("view:")
      ? action.slice("view:".length)
      : action.startsWith("refresh:")
        ? action.slice("refresh:".length)
        : null;

    const parsed = traderIdSchema.safeParse(targetId ?? "");

    if (!parsed.success) {
      alert = "Неизвестное действие раздела «Активные трейдеры».";
      return true;
    }

    const traders = await getTraders();
    const trader =
      traders.find((user) => user.telegramId === parsed.data) ?? null;

    if (!trader) {
      alert = "Трейдер не найден.";
      return true;
    }

    if (action.startsWith("refresh:")) {
      const refreshed = await refreshTraderStatsSafe(trader);
      alert = refreshed
        ? "Статистика обновлена"
        : "Не удалось обновить статистику. Попробуйте позже.";
    }

    await renderScreen(
      token,
      chatId,
      messageId,
      await buildTraderCard(trader, telegramId)
    );
    return true;
  } finally {
    await answerCallbackQuery(token, callbackQueryId, alert);
  }
}

async function renderScreen(
  token: string,
  chatId: number,
  messageId: number | undefined,
  screen: { text: string; keyboard: InlineKeyboardMarkup }
): Promise<void> {
  if (messageId) {
    await editMessageText(
      token,
      chatId,
      messageId,
      screen.text,
      screen.keyboard
    );
  } else {
    await sendMessage(token, chatId, screen.text, screen.keyboard);
  }
}
