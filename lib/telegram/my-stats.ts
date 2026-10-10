import type { InlineKeyboardMarkup } from "./api";
import { answerCallbackQuery, editMessageText, sendMessage } from "./api";
import { formatHoldTimeFp9, formatSignedFp9 } from "@/lib/upscale/fp9";
import {
  listBotUsers,
  listTradesBySubscriber,
  type BotUser,
  type Trade,
} from "@/lib/models";
import { summarizeTrades } from "@/lib/trades";

/** Префикс callback-дат раздела «Моя статистика». */
export const CALLBACK_MY_STATS_PREFIX = "mystats:";

/** Сколько последних сделок показывается на экране. */
const HISTORY_LIMIT = 10;

function backToMenuRow(): InlineKeyboardMarkup["inline_keyboard"][number] {
  return [{ text: "⬅️ В главное меню", callback_data: "menu" }];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`,
  ].join(" ");
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

function formatTradeEntry(
  index: number,
  trade: Trade,
  tradersById: Map<string, BotUser>
): string[] {
  const asset = escapeHtml(trade.asset ?? trade.marketId ?? "—");
  const side =
    trade.side === "sell" ? "продажа" : trade.side === "buy" ? "покупка" : "—";
  const pnl = formatSignedFp9(trade.pnlFp9);
  const pnlResult = trade.pnlFp9 === null ? "результат недоступен" : pnl;
  const hold = trade.holdTimeSecFp9
    ? ` · ${formatHoldTimeFp9(trade.holdTimeSecFp9)}`
    : "";
  const trader = tradersById.get(trade.traderTelegramId);
  const traderName = trader
    ? (trader.tag ?? trader.username ?? `ID ${trader.telegramId}`)
    : `ID ${trade.traderTelegramId}`;

  return [
    `${index}. <b>${asset}</b> — ${escapeHtml(side)}: <b>${escapeHtml(pnlResult)} USD</b>${hold}`,
    `    ${formatDateTime(trade.closedAt)} · трейдер: ${escapeHtml(traderName)}`,
  ];
}

/**
 * Экран «Моя статистика»: итоги и история скопированных сделок участника
 * с результатом (PnL), активом, направлением и временем удержания.
 */
export async function buildMyStatsScreen(
  telegramId: string
): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
  const [trades, users] = await Promise.all([
    listTradesBySubscriber(telegramId, HISTORY_LIMIT),
    listBotUsers().catch(() => [] as BotUser[]),
  ]);

  const tradersById = new Map(
    users.map((user) => [user.telegramId, user] as const)
  );
  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };

  if (trades.length === 0) {
    return {
      text: [
        "<b>📊 Моя статистика</b>",
        "",
        "📭 Скопированных сделок пока нет.",
        "",
        "Подпишитесь на трейдера в разделе «Активные трейдеры» — после закрытия каждой копии здесь появится результат сделки.",
      ].join("\n"),
      keyboard: {
        inline_keyboard: [
          [
            {
              text: "📈 Активные трейдеры",
              callback_data: "section:traders",
            },
          ],
          backToMenuRow(),
        ],
      },
    };
  }

  const totals = summarizeTrades(trades);

  const lines: string[] = [
    "<b>📊 Моя статистика</b>",
    "",
    `Скопированных сделок (последние): <b>${totals.count}</b>`,
    `Прибыльных: <b>${totals.wins}</b> · Убыточных: <b>${totals.losses}</b>`,
    `Суммарный результат: <b>${formatSignedFp9(totals.totalPnlFp9)} USD</b>`,
    "",
    "<b>История скопированных сделок</b>",
    "",
  ];

  trades.forEach((trade, index) => {
    lines.push(...formatTradeEntry(index + 1, trade, tradersById));
  });

  const decided = totals.wins + totals.losses;
  const winRate =
    decided > 0 ? Math.round((totals.wins / decided) * 100) : null;

  if (winRate !== null) {
    lines.push(
      "",
      `Винрейт: <b>${winRate}%</b> (${decided} ${pluralize(
        decided,
        "сделка",
        "сделки",
        "сделок"
      )} с известным результатом)`
    );
  }

  keyboard.inline_keyboard.push([
    {
      text: "🔄 Обновить",
      callback_data: `${CALLBACK_MY_STATS_PREFIX}refresh`,
    },
  ]);
  keyboard.inline_keyboard.push(backToMenuRow());

  return { text: lines.join("\n"), keyboard };
}

/**
 * Обрабатывает callback-запросы раздела «Моя статистика».
 * Возвращает true, если callback относится к разделу.
 */
export async function handleMyStatsCallback(
  token: string,
  chatId: number,
  telegramId: string,
  messageId: number | undefined,
  callbackQueryId: string,
  data: string
): Promise<boolean> {
  if (!data.startsWith(CALLBACK_MY_STATS_PREFIX)) return false;

  const action = data.slice(CALLBACK_MY_STATS_PREFIX.length);
  let alert: string | undefined;

  try {
    if (action === "refresh") {
      const screen = await buildMyStatsScreen(telegramId);

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

      alert = "Статистика обновлена";
      return true;
    }

    alert = "Неизвестное действие раздела «Моя статистика».";
    return true;
  } finally {
    await answerCallbackQuery(token, callbackQueryId, alert);
  }
}
