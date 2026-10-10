import { fetchClosedPositionPnlFp9 } from "@/lib/upscale/client";
import { formatSignedFp9 } from "@/lib/upscale/fp9";
import {
  getTraderStats,
  listTradesByTrader,
  listTradesBySubscriber,
  putTrade,
  putTraderStats,
  type BotUser,
  type CopyPosition,
  type Trade,
  type TraderStats,
} from "@/lib/models";

const FP9_SCALE = 1_000_000_000n;

/** Максимальное число сделок, по которым пересчитываются агрегаты трейдера. */
const AGGREGATE_TRADES_LIMIT = 500;

/**
 * RR сделки: |take − open| / |open − stop| в fp9 (чистый BigInt).
 * Возвращает null, если ценовых уровней недостаточно или стоп совпадает с входом.
 */
export function computeRrFp9(
  openPriceFp9: string | null | undefined,
  stopTriggerPriceFp9: string | null | undefined,
  takeTriggerPriceFp9: string | null | undefined
): string | null {
  const values = [openPriceFp9, stopTriggerPriceFp9, takeTriggerPriceFp9];

  for (const value of values) {
    if (!value || !/^-?\d+$/.test(value.trim())) return null;
  }

  const open = BigInt((openPriceFp9 as string).trim());
  const stop = BigInt((stopTriggerPriceFp9 as string).trim());
  const take = BigInt((takeTriggerPriceFp9 as string).trim());
  const risk = open > stop ? open - stop : stop - open;

  if (risk === 0n) return null;

  const reward = open > take ? open - take : take - open;

  return ((reward * FP9_SCALE) / risk).toString();
}

function computeHoldTimeSecFp9(
  openedAt: string | null,
  closedAt: string
): string | null {
  if (!openedAt) return null;

  const openedMs = Date.parse(openedAt);
  const closedMs = Date.parse(closedAt);

  if (Number.isNaN(openedMs) || Number.isNaN(closedMs)) return null;

  const seconds = Math.max(0, Math.floor((closedMs - openedMs) / 1000));

  return (BigInt(seconds) * FP9_SCALE).toString();
}

/**
 * Пересчитывает агрегаты скопированных сделок трейдера (число сделок,
 * винрейт, средний RR, среднее время удержания, топ-актив) и сохраняет
 * их в снимке статистики карточки (bot_trader_stats).
 */
export async function recomputeTraderTradeAggregate(
  traderTelegramId: string
): Promise<void> {
  const trades = await listTradesByTrader(
    traderTelegramId,
    AGGREGATE_TRADES_LIMIT
  );
  const existing = await getTraderStats(traderTelegramId);
  const now = new Date().toISOString();

  const wins = trades.filter((trade) => trade.result === "win").length;
  const losses = trades.filter((trade) => trade.result === "loss").length;

  const rrValues = trades
    .map((trade) => trade.rrFp9)
    .filter((value): value is string => !!value);
  const avgRrFp9 =
    rrValues.length > 0
      ? (
          rrValues.reduce((acc, value) => acc + BigInt(value), 0n) /
          BigInt(rrValues.length)
        ).toString()
      : null;

  const holdValues = trades
    .map((trade) => trade.holdTimeSecFp9)
    .filter((value): value is string => !!value);
  const avgHoldTimeFp9 =
    holdValues.length > 0
      ? (
          holdValues.reduce((acc, value) => acc + BigInt(value), 0n) /
          BigInt(holdValues.length)
        ).toString()
      : null;

  const assetCounts = new Map<string, number>();
  for (const trade of trades) {
    if (!trade.asset) continue;
    assetCounts.set(trade.asset, (assetCounts.get(trade.asset) ?? 0) + 1);
  }
  let botTopAsset: string | null = null;
  let bestCount = 0;
  for (const [asset, count] of assetCounts) {
    if (count > bestCount) {
      botTopAsset = asset;
      bestCount = count;
    }
  }

  const snapshot: TraderStats = existing
    ? { ...existing, updatedAt: now }
    : {
        traderTelegramId,
        primaryAccountId: null,
        positionsCount: null,
        winRateFp9: null,
        riskRewardRatioFp9: null,
        avgPositionHoldTimeFp9: null,
        topAsset: null,
        hasStats: false,
        fetchedAt: now,
        updatedAt: now,
      };

  await putTraderStats({
    ...snapshot,
    botTradesCount: trades.length,
    botWins: wins,
    botLosses: losses,
    botAvgRrFp9: avgRrFp9,
    botAvgHoldTimeFp9: avgHoldTimeFp9,
    botTopAsset,
  });
}

/**
 * Фиксирует закрытую скопированную сделку: определяет PnL по истории
 * портфеля UpScale, RR и время удержания копии, сохраняет сделку
 * в bot_trades и обновляет агрегаты карточки трейдера.
 */
export async function recordClosedCopyTrade(
  copy: CopyPosition,
  apiKey: string
): Promise<Trade> {
  const closedAt = copy.closedAt ?? new Date().toISOString();
  const now = new Date().toISOString();

  let pnlFp9: string | null = null;

  if (copy.copyPositionId) {
    try {
      pnlFp9 = await fetchClosedPositionPnlFp9(
        apiKey,
        copy.copyAccountId,
        copy.copyPositionId
      );
    } catch (error) {
      console.error(
        `Failed to fetch closed position PnL (copy ${copy.copyId}):`,
        error
      );
    }
  }

  const result =
    pnlFp9 === null ? "unknown" : BigInt(pnlFp9) >= 0n ? "win" : "loss";

  const trade: Trade = {
    tradeId: copy.copyId,
    traderTelegramId: copy.traderTelegramId,
    subscriberTelegramId: copy.subscriberTelegramId,
    copyAccountId: copy.copyAccountId,
    marketId: copy.marketId,
    asset: copy.asset,
    side: copy.side,
    pnlFp9,
    result,
    rrFp9: computeRrFp9(
      copy.openPriceFp9,
      copy.stopTriggerPriceFp9,
      copy.takeTriggerPriceFp9
    ),
    holdTimeSecFp9: computeHoldTimeSecFp9(copy.openedAt, closedAt),
    amountFp9: copy.appliedAmountFp9 ?? null,
    openedAt: copy.openedAt,
    closedAt,
    createdAt: now,
    updatedAt: now,
  };

  await putTrade(trade);

  try {
    await recomputeTraderTradeAggregate(copy.traderTelegramId);
  } catch (error) {
    console.error(
      `Failed to recompute trader trade aggregate ${copy.traderTelegramId}:`,
      error
    );
  }

  return trade;
}

/** Строка «результат» сделки для чата: «+12.5 USD», «−3.2 USD» или «— USD». */
export function formatTradePnl(pnlFp9: string | null): string {
  return `${formatSignedFp9(pnlFp9)} USD`;
}

/** Человекочитаемое имя участника/трейдера. */
export function displayName(
  user: Pick<BotUser, "tag" | "username" | "telegramId">
): string {
  return user.tag ?? user.username ?? `ID ${user.telegramId}`;
}

/** Итоги по списку сделок для экранов истории. */
export interface TradeTotals {
  count: number;
  wins: number;
  losses: number;
  unknown: number;
  totalPnlFp9: string | null;
}

export function summarizeTrades(trades: Trade[]): TradeTotals {
  let wins = 0;
  let losses = 0;
  let unknown = 0;
  let pnlSum = 0n;
  let hasPnl = false;

  for (const trade of trades) {
    if (trade.result === "win") wins++;
    else if (trade.result === "loss") losses++;
    else unknown++;

    if (trade.pnlFp9) {
      pnlSum += BigInt(trade.pnlFp9);
      hasPnl = true;
    }
  }

  return {
    count: trades.length,
    wins,
    losses,
    unknown,
    totalPnlFp9: hasPnl ? pnlSum.toString() : null,
  };
}

export { listTradesBySubscriber, listTradesByTrader };
