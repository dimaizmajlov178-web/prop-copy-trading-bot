import { randomUUID } from "crypto";
import { isDatabaseAvailable } from "@/lib/db";
import {
  getCopyPosition,
  listBotUsers,
  listCopyPositionsBySubscriber,
  listCopyPositionsByTraderPosition,
  listSubscriptionsByTrader,
  listTraderPositionStates,
  listUpscaleBindings,
  deleteTraderPositionState,
  putCopyPosition,
  putTraderPositionState,
  type BotUser,
  type CopyPosition,
  type TraderPositionState,
  type TraderSubscription,
  type UpscaleAccountInfo,
  type UpscaleBinding,
} from "@/lib/models";
import { isAccessExpired } from "@/lib/telegram/access";
import { decryptSecret } from "@/lib/telegram/crypto";
import { notifyUser } from "@/lib/telegram/notify";
import { isCopyBlockedByDrawdown } from "@/lib/copy/drawdown";
import {
  UpscaleApiError,
  createOrder,
  fetchActivePositions,
  type UpscalePosition,
} from "@/lib/upscale/client";
import { formatFp9 } from "@/lib/upscale/fp9";
import { computeCopyAmountFp9, fp9DeltaFp9, isFp9Greater } from "./volume";
import { formatTradePnl, recordClosedCopyTrade } from "@/lib/trades";

export interface CopyEngineCycleStats {
  tradersProcessed: number;
  copiesOpened: number;
  copiesIncreased: number;
  copiesClosed: number;
  failures: number;
  errors: string[];
}

/** Допустимое расхождение времени при сопоставлении позиции-копии (мс). */
const MATCH_TIME_SLACK_MS = 5_000;

interface CopyAccountRef {
  binding: UpscaleBinding;
  account: UpscaleAccountInfo;
}

function describeError(error: unknown): string {
  if (error instanceof UpscaleApiError) return error.userMessage;
  console.error("Copy engine internal error:", error);
  return "Внутренняя ошибка движка копирования. Попробуйте позже.";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function displayName(user: BotUser): string {
  return user.tag ?? user.username ?? `ID ${user.telegramId}`;
}

function formatSide(side: "buy" | "sell" | null): string {
  if (side === "buy") return "покупка";
  if (side === "sell") return "продажа";
  return "—";
}

function isPositiveFp9(value: string | null | undefined): boolean {
  return !!value && /^\d+$/.test(value.trim()) && BigInt(value) > 0n;
}

/** Дополнительные счета подписчика, пригодные для копирования (API-торговля включена). */
async function getCopyAccounts(
  subscriberTelegramId: string
): Promise<CopyAccountRef[]> {
  const bindings = await listUpscaleBindings(subscriberTelegramId);
  const refs: CopyAccountRef[] = [];

  for (const binding of bindings) {
    if (binding.kind !== "additional") continue;
    for (const account of binding.accounts) {
      if (account.apiTrading && isPositiveFp9(account.equityFp9)) {
        refs.push({ binding, account });
      }
    }
  }

  return refs;
}

async function getCopyAccount(
  subscriberTelegramId: string,
  bindingId: string,
  accountId: string
): Promise<CopyAccountRef | null> {
  const refs = await getCopyAccounts(subscriberTelegramId);
  return (
    refs.find(
      (ref) =>
        ref.binding.bindingId === bindingId &&
        ref.account.accountId === accountId
    ) ?? null
  );
}

function decryptApiKey(binding: UpscaleBinding): string {
  return decryptSecret(binding.apiKeyEncrypted);
}

function marketMatches(
  copyMarket: string | null,
  position: UpscalePosition
): boolean {
  if (!copyMarket) return false;
  return copyMarket === position.marketId || copyMarket === position.asset;
}

/**
 * Ищет позицию-копию среди активных позиций дополнительного счета: ответ
 * ордера не содержит id позиции, поэтому он фиксируется чтением
 * GET /positions/{accountId}/active.
 */
async function resolveCopyPosition(
  apiKey: string,
  accountId: string,
  copy: CopyPosition,
  notBeforeMs: number
): Promise<UpscalePosition | null> {
  const active = await fetchActivePositions(apiKey, accountId);

  const knownIds = new Set<string>();
  const copiesOfSubscriber = await listCopyPositionsBySubscriber(
    copy.subscriberTelegramId
  );
  for (const other of copiesOfSubscriber) {
    if (
      other.copyAccountId === accountId &&
      other.copyId !== copy.copyId &&
      other.copyPositionId
    ) {
      knownIds.add(other.copyPositionId);
    }
  }

  const candidates = active.filter(
    (position) =>
      (!position.positionId || !knownIds.has(position.positionId)) &&
      marketMatches(copy.marketId, position) &&
      (!copy.side || !position.side || copy.side === position.side) &&
      (position.openedAtMs === null ||
        position.openedAtMs >= notBeforeMs - MATCH_TIME_SLACK_MS)
  );

  if (candidates.length === 0) return null;

  return (
    candidates.sort((a, b) => (b.openedAtMs ?? 0) - (a.openedAtMs ?? 0))[0] ??
    null
  );
}

function buildOpenCopyText(trader: BotUser, copy: CopyPosition): string {
  const lines = [
    "🟢 <b>Открыта копия позиции</b>",
    "",
    `Трейдер: <b>${escapeHtml(displayName(trader))}</b>`,
    `Актив: <b>${escapeHtml(copy.asset ?? copy.marketId ?? "—")}</b>`,
    `Направление: ${escapeHtml(formatSide(copy.side))}`,
    `Объём: <b>${formatFp9(copy.appliedAmountFp9)}</b> USD`,
    `Счет: <code>${escapeHtml(copy.copyAccountId)}</code>`,
  ];

  if (copy.stopTriggerPriceFp9) {
    lines.push(`Стоп-лосс: ${formatFp9(copy.stopTriggerPriceFp9)}`);
  }
  if (copy.takeTriggerPriceFp9) {
    lines.push(`Тейк-профит: ${formatFp9(copy.takeTriggerPriceFp9)}`);
  }

  return lines.join("\n");
}

function buildCloseCopyText(
  trader: BotUser,
  copy: CopyPosition,
  pnlFp9: string | null
): string {
  const lines = [
    "🔴 <b>Копия позиции закрыта</b>",
    "",
    `Трейдер: <b>${escapeHtml(displayName(trader))}</b>`,
    `Актив: <b>${escapeHtml(copy.asset ?? copy.marketId ?? "—")}</b>`,
    `Направление: ${escapeHtml(formatSide(copy.side))}`,
    `Счет: <code>${escapeHtml(copy.copyAccountId)}</code>`,
    `Результат: <b>${formatTradePnl(pnlFp9)}</b>`,
    "",
    "Трейдер закрыл исходную позицию — копия закрыта вместе с ней.",
  ];

  return lines.join("\n");
}

function newCopyRecord(
  trader: BotUser,
  position: UpscalePosition,
  subscriberTelegramId: string,
  accountRef: CopyAccountRef,
  coefficient: string,
  amountFp9: string,
  nowIso: string
): CopyPosition {
  return {
    copyId: `${trader.telegramId}:${position.positionId}:${accountRef.account.accountId}`,
    traderTelegramId: trader.telegramId,
    traderPositionId: position.positionId as string,
    subscriberTelegramId,
    copyAccountId: accountRef.account.accountId,
    bindingId: accountRef.binding.bindingId,
    status: "pending",
    openIdempotencyKey: randomUUID(),
    closeIdempotencyKey: null,
    pendingIncreaseFp9: null,
    pendingIncreaseIdempotencyKey: null,
    appliedAmountFp9: amountFp9,
    copySizeFp9: null,
    copyPositionId: null,
    coefficient,
    marketId: position.marketId,
    asset: position.asset,
    side: position.side,
    openPriceFp9: null,
    stopTriggerPriceFp9: position.stopTriggerPriceFp9,
    takeTriggerPriceFp9: position.takeTriggerPriceFp9,
    createdAt: nowIso,
    updatedAt: nowIso,
    openedAt: null,
    closedAt: null,
    failureReason: null,
  };
}

/**
 * Новая позиция трейдера: фиксирует состояние, считает объём копий
 * (объём позиции × счет подписчика / счет трейдера × коэффициент)
 * и открывает market-ордера на дополнительных счетах подписчиков.
 */
async function handleNewTraderPosition(
  trader: BotUser,
  position: UpscalePosition,
  traderEquityFp9: string,
  subscriptions: TraderSubscription[],
  stats: CopyEngineCycleStats
): Promise<void> {
  const now = new Date().toISOString();

  const state: TraderPositionState = {
    traderTelegramId: trader.telegramId,
    positionId: position.positionId as string,
    marketId: position.marketId,
    asset: position.asset,
    side: position.side,
    traderAmountFp9: position.amountFp9 ?? "0",
    traderSizeFp9: position.sizeFp9,
    version: position.version,
    firstSeenAt: now,
    updatedAt: now,
  };
  await putTraderPositionState(state);

  if (!position.amountFp9) {
    stats.errors.push(
      `Трейдер ${trader.telegramId}: у позиции ${position.positionId} нет объёма (amount) — копирование невозможно.`
    );
    return;
  }

  const marketId = position.marketId ?? position.asset;

  if (!marketId) {
    stats.errors.push(
      `Трейдер ${trader.telegramId}: у позиции ${position.positionId} не определен рынок — копирование невозможно.`
    );
    return;
  }

  for (const subscription of subscriptions) {
    const coefficient = subscription.coefficient;
    const copyAccounts = await getCopyAccounts(
      subscription.subscriberTelegramId
    );

    for (const accountRef of copyAccounts) {
      // Лимит дневной просадки достигнут на этом счете — новые копии
      // не открываются до конца торгового дня.
      if (
        await isCopyBlockedByDrawdown(
          subscription.subscriberTelegramId,
          accountRef.account.accountId
        )
      ) {
        continue;
      }

      const copyId = `${trader.telegramId}:${position.positionId}:${accountRef.account.accountId}`;
      const existing = await getCopyPosition(copyId);

      if (existing && existing.status !== "pending") continue;

      const amountFp9 = computeCopyAmountFp9(
        position.amountFp9,
        accountRef.account.equityFp9 as string,
        traderEquityFp9,
        coefficient
      );

      let copy: CopyPosition;

      if (!amountFp9) {
        if (existing) continue;
        copy = newCopyRecord(
          trader,
          position,
          subscription.subscriberTelegramId,
          accountRef,
          coefficient,
          "0",
          now
        );
        copy.status = "failed";
        copy.failureReason =
          "Не удалось рассчитать объём копии: проверьте эквити счетов и коэффициент подписки.";
        await putCopyPosition(copy);
        await notifyUser(
          copy.subscriberTelegramId,
          `⚠️ Не удалось открыть копию позиции (${escapeHtml(
            copy.asset ?? copy.marketId ?? "—"
          )}): ${copy.failureReason}`
        );
        stats.failures++;
        continue;
      }

      if (existing) {
        // Повторный опрос: ордер уже отправлялся — повторяем с тем же
        // x-idempotency-key, чтобы не создать дубликат копии.
        copy = existing;
      } else {
        copy = newCopyRecord(
          trader,
          position,
          subscription.subscriberTelegramId,
          accountRef,
          coefficient,
          amountFp9,
          now
        );
      }

      copy.updatedAt = new Date().toISOString();
      await putCopyPosition(copy);

      const apiKey = decryptApiKey(accountRef.binding);
      const order = {
        type: "market" as const,
        marketId,
        ...(copy.side ? { side: copy.side } : {}),
        amount: copy.appliedAmountFp9,
        ...(position.leverageFp9 ? { leverage: position.leverageFp9 } : {}),
        // Стоп-лосс и тейк-профит копируются пропорционально ценовым
        // уровням исходной позиции (тот же рынок — те же уровни цен).
        ...(copy.stopTriggerPriceFp9
          ? { stopTriggerPrice: copy.stopTriggerPriceFp9 }
          : {}),
        ...(copy.takeTriggerPriceFp9
          ? { takeTriggerPrice: copy.takeTriggerPriceFp9 }
          : {}),
      };

      try {
        await createOrder(apiKey, order, copy.openIdempotencyKey as string);

        const copyPosition = await resolveCopyPosition(
          apiKey,
          copy.copyAccountId,
          copy,
          Date.parse(copy.createdAt)
        );

        copy.status = "open";
        copy.openedAt = new Date().toISOString();

        if (copyPosition) {
          if (copyPosition.positionId) {
            copy.copyPositionId = copyPosition.positionId;
          }
          if (copyPosition.sizeFp9) {
            copy.copySizeFp9 = copyPosition.sizeFp9;
          }
          if (copyPosition.openPriceFp9) {
            copy.openPriceFp9 = copyPosition.openPriceFp9;
          }
        }

        await putCopyPosition(copy);
        stats.copiesOpened++;

        await notifyUser(
          copy.subscriberTelegramId,
          buildOpenCopyText(trader, copy)
        );
      } catch (error) {
        const message = describeError(error);
        copy.status = "failed";
        copy.failureReason = message;
        await putCopyPosition(copy);
        stats.failures++;

        await notifyUser(
          copy.subscriberTelegramId,
          `⚠️ Не удалось открыть копию позиции (${escapeHtml(
            copy.asset ?? copy.marketId ?? "—"
          )}): ${escapeHtml(message)}`
        );
      }
    }
  }
}

/**
 * Увеличение позиции трейдера (рост size/version): увеличивает открытые
 * копии дополнительным market-ордером на дельту объёма.
 */
async function handleIncreasedTraderPosition(
  trader: BotUser,
  position: UpscalePosition,
  state: TraderPositionState,
  traderEquityFp9: string,
  subscriptions: TraderSubscription[],
  stats: CopyEngineCycleStats
): Promise<void> {
  const nowIso = new Date().toISOString();

  const amountGrew =
    !!position.amountFp9 &&
    state.traderAmountFp9 !== "0" &&
    isFp9Greater(position.amountFp9, state.traderAmountFp9);
  const sizeGrew =
    !!position.sizeFp9 &&
    !!state.traderSizeFp9 &&
    isFp9Greater(position.sizeFp9, state.traderSizeFp9);

  if (!amountGrew && !sizeGrew) return;

  const deltaFp9 =
    amountGrew && position.amountFp9
      ? fp9DeltaFp9(position.amountFp9, state.traderAmountFp9)
      : null;

  const copies = await listCopyPositionsByTraderPosition(
    trader.telegramId,
    state.positionId
  );

  const marketId = position.marketId ?? position.asset;

  for (const copy of copies) {
    if (copy.status !== "open" && copy.status !== "pending") continue;
    if (!deltaFp9 || !marketId) continue;

    const accountRef = await getCopyAccount(
      copy.subscriberTelegramId,
      copy.bindingId,
      copy.copyAccountId
    );

    if (!accountRef) continue;

    let increaseFp9: string | null;
    let idempotencyKey: string;

    if (copy.pendingIncreaseFp9 && copy.pendingIncreaseIdempotencyKey) {
      // Предыдущая попытка увеличения не подтверждена — повторяем
      // с тем же x-idempotency-key, чтобы не удвоить объём.
      increaseFp9 = copy.pendingIncreaseFp9;
      idempotencyKey = copy.pendingIncreaseIdempotencyKey;
    } else {
      increaseFp9 = computeCopyAmountFp9(
        deltaFp9,
        accountRef.account.equityFp9 as string,
        traderEquityFp9,
        copy.coefficient
      );
      idempotencyKey = randomUUID();
    }

    if (!increaseFp9) continue;

    copy.pendingIncreaseFp9 = increaseFp9;
    copy.pendingIncreaseIdempotencyKey = idempotencyKey;
    copy.updatedAt = nowIso;
    await putCopyPosition(copy);

    const apiKey = decryptApiKey(accountRef.binding);

    try {
      await createOrder(
        apiKey,
        {
          type: "market",
          marketId,
          ...(copy.side ? { side: copy.side } : {}),
          amount: increaseFp9,
        },
        idempotencyKey
      );

      copy.appliedAmountFp9 = (
        BigInt(copy.appliedAmountFp9 || "0") + BigInt(increaseFp9)
      ).toString();
      copy.pendingIncreaseFp9 = null;
      copy.pendingIncreaseIdempotencyKey = null;
      copy.updatedAt = new Date().toISOString();
      await putCopyPosition(copy);
      stats.copiesIncreased++;

      await notifyUser(
        copy.subscriberTelegramId,
        [
          "🟡 <b>Копия позиции увеличена</b>",
          "",
          `Трейдер: <b>${escapeHtml(displayName(trader))}</b>`,
          `Актив: <b>${escapeHtml(copy.asset ?? copy.marketId ?? "—")}</b>`,
          `Добавлено: <b>${formatFp9(increaseFp9)}</b> USD`,
          `Общий объём: <b>${formatFp9(copy.appliedAmountFp9)}</b> USD`,
          `Счет: <code>${escapeHtml(copy.copyAccountId)}</code>`,
        ].join("\n")
      );
    } catch (error) {
      const message = describeError(error);
      copy.pendingIncreaseFp9 = null;
      copy.pendingIncreaseIdempotencyKey = null;
      copy.updatedAt = new Date().toISOString();
      await putCopyPosition(copy);
      stats.failures++;

      await notifyUser(
        copy.subscriberTelegramId,
        `⚠️ Не удалось увеличить копию позиции (${escapeHtml(
          copy.asset ?? copy.marketId ?? "—"
        )}): ${escapeHtml(message)}`
      );
    }
  }

  state.traderAmountFp9 = position.amountFp9 ?? state.traderAmountFp9;
  state.traderSizeFp9 = position.sizeFp9 ?? state.traderSizeFp9;
  state.version = position.version ?? state.version;
  state.updatedAt = nowIso;
  await putTraderPositionState(state);
}

/** Закрытие копии take-ордером с triggerPrice "0" и amount = размер копии в базовом активе. */
async function closeCopy(
  trader: BotUser,
  copy: CopyPosition,
  apiKey: string,
  stats: CopyEngineCycleStats
): Promise<void> {
  const nowIso = new Date().toISOString();

  if (copy.status === "pending") {
    // Ордер открытия ещё не подтвержден — пытаемся найти позицию-копию.
    const accountRef = await getCopyAccount(
      copy.subscriberTelegramId,
      copy.bindingId,
      copy.copyAccountId
    );

    if (accountRef) {
      try {
        const resolved = await resolveCopyPosition(
          decryptApiKey(accountRef.binding),
          copy.copyAccountId,
          copy,
          Date.parse(copy.createdAt)
        );
        if (resolved) {
          if (resolved.positionId) copy.copyPositionId = resolved.positionId;
          if (resolved.sizeFp9) copy.copySizeFp9 = resolved.sizeFp9;
          if (resolved.openPriceFp9) copy.openPriceFp9 = resolved.openPriceFp9;
        }
      } catch {
        // Состояние ордера неизвестно — считаем копию не открывшейся.
      }
    }

    if (!copy.copySizeFp9) {
      copy.status = "failed";
      copy.failureReason =
        "Ордер открытия не был исполнен до закрытия позиции трейдера.";
      copy.updatedAt = nowIso;
      await putCopyPosition(copy);
      return;
    }
  }

  if (!copy.copySizeFp9) {
    copy.status = "failed";
    copy.failureReason =
      "Неизвестен размер копии в базовом активе — закрытие невозможно.";
    copy.updatedAt = nowIso;
    await putCopyPosition(copy);
    stats.failures++;
    await notifyUser(
      copy.subscriberTelegramId,
      `⚠️ Трейдер закрыл позицию, но размер копии на счете <code>${escapeHtml(
        copy.copyAccountId
      )}</code> неизвестен — закройте позицию вручную в UpScale.`
    );
    return;
  }

  const reuseKey = copy.status === "closing" && copy.closeIdempotencyKey;
  const closeIdempotencyKey = reuseKey
    ? (copy.closeIdempotencyKey as string)
    : randomUUID();

  copy.status = "closing";
  copy.closeIdempotencyKey = closeIdempotencyKey;
  copy.updatedAt = nowIso;
  await putCopyPosition(copy);

  try {
    await createOrder(
      apiKey,
      {
        type: "take",
        ...(copy.marketId ? { marketId: copy.marketId } : {}),
        ...(copy.side ? { side: copy.side } : {}),
        triggerPrice: "0",
        amount: copy.copySizeFp9,
      },
      closeIdempotencyKey
    );

    copy.status = "closed";
    copy.closedAt = new Date().toISOString();
    copy.updatedAt = copy.closedAt;
    await putCopyPosition(copy);
    stats.copiesClosed++;

    // Фиксируем закрытую скопированную сделку (актив, направление, PnL,
    // время удержания) и обновляем агрегаты карточки трейдера.
    let pnlFp9: string | null = null;

    try {
      const trade = await recordClosedCopyTrade(copy, apiKey);
      pnlFp9 = trade.pnlFp9;
    } catch (error) {
      console.error(`Failed to record closed trade ${copy.copyId}:`, error);
    }

    await notifyUser(
      copy.subscriberTelegramId,
      buildCloseCopyText(trader, copy, pnlFp9)
    );
  } catch (error) {
    if (
      error instanceof UpscaleApiError &&
      (error.code === "position_not_found" || error.code === "order_not_found")
    ) {
      // Позиция уже закрыта — считаем копию закрытой.
      copy.status = "closed";
      copy.closedAt = new Date().toISOString();
      copy.updatedAt = copy.closedAt;
      await putCopyPosition(copy);
      stats.copiesClosed++;

      // Сделка могла закрыться сама (стоп/тейк) — тоже фиксируем её результат.
      try {
        await recordClosedCopyTrade(copy, apiKey);
      } catch (recordError) {
        console.error(
          `Failed to record closed trade ${copy.copyId}:`,
          recordError
        );
      }
      return;
    }

    // Возврат в статус open — следующая итерация повторит закрытие
    // с тем же идемпотентным ключом.
    copy.status = "open";
    copy.updatedAt = new Date().toISOString();
    await putCopyPosition(copy);
    stats.failures++;

    const message = describeError(error);
    await notifyUser(
      copy.subscriberTelegramId,
      `⚠️ Не удалось закрыть копию позиции (${escapeHtml(
        copy.asset ?? copy.marketId ?? "—"
      )}): ${escapeHtml(message)} Закройте позицию вручную, если ошибка повторится.`
    );
  }
}

/** Позиция трейдера исчезла из активных — закрываем все её копии. */
async function handleTraderPositionClosed(
  trader: BotUser,
  state: TraderPositionState,
  stats: CopyEngineCycleStats
): Promise<void> {
  const copies = await listCopyPositionsByTraderPosition(
    trader.telegramId,
    state.positionId
  );

  for (const copy of copies) {
    if (copy.status === "closed" || copy.status === "failed") continue;

    const accountRef = await getCopyAccount(
      copy.subscriberTelegramId,
      copy.bindingId,
      copy.copyAccountId
    );

    try {
      if (accountRef) {
        await closeCopy(trader, copy, decryptApiKey(accountRef.binding), stats);
      } else {
        copy.status = "failed";
        copy.failureReason =
          "Дополнительный счет больше не привязан — копия не закрыта автоматически.";
        copy.updatedAt = new Date().toISOString();
        await putCopyPosition(copy);
        stats.failures++;
        await notifyUser(
          copy.subscriberTelegramId,
          `⚠️ Трейдер закрыл позицию, но счет <code>${escapeHtml(
            copy.copyAccountId
          )}</code> больше не привязан — закройте копию вручную в UpScale.`
        );
      }
    } catch (error) {
      stats.failures++;
      stats.errors.push(
        `Трейдер ${trader.telegramId}: ошибка закрытия копии ${copy.copyId}: ${describeError(error)}`
      );
    }
  }

  await deleteTraderPositionState(trader.telegramId, state.positionId);
}

async function syncTrader(
  trader: BotUser,
  usersById: Map<string, BotUser>,
  stats: CopyEngineCycleStats
): Promise<void> {
  const bindings = await listUpscaleBindings(trader.telegramId);
  const primaryBinding = bindings.find(
    (binding) => binding.kind === "primary" && binding.accounts.length > 0
  );

  if (!primaryBinding) return;

  const traderAccount = primaryBinding.accounts[0];

  if (!traderAccount.apiTrading) return;

  let traderApiKey: string;

  try {
    traderApiKey = decryptApiKey(primaryBinding);
  } catch (error) {
    console.error(`Failed to decrypt trader key ${trader.telegramId}:`, error);
    stats.errors.push(
      `Трейдер ${trader.telegramId}: не удалось расшифровать API-ключ.`
    );
    return;
  }

  const traderEquityFp9 = traderAccount.equityFp9;

  if (!traderEquityFp9 || !isPositiveFp9(traderEquityFp9)) return;

  let positions: UpscalePosition[];

  try {
    positions = await fetchActivePositions(
      traderApiKey,
      traderAccount.accountId
    );
  } catch (error) {
    stats.errors.push(
      `Трейдер ${trader.telegramId}: не удалось получить активные позиции: ${describeError(error)}`
    );
    return;
  }

  stats.tradersProcessed++;

  const states = await listTraderPositionStates(trader.telegramId);
  const stateByPositionId = new Map(
    states.map((state) => [state.positionId, state])
  );
  const currentPositionIds = new Set<string>();

  for (const position of positions) {
    if (position.positionId) currentPositionIds.add(position.positionId);
  }

  for (const state of states) {
    if (!currentPositionIds.has(state.positionId)) {
      await handleTraderPositionClosed(trader, state, stats);
    }
  }

  const subscriptions = (
    await listSubscriptionsByTrader(trader.telegramId)
  ).filter((subscription) => {
    const subscriber = usersById.get(subscription.subscriberTelegramId);
    return !!subscriber && !isAccessExpired(subscriber);
  });

  for (const position of positions) {
    if (!position.positionId) continue;

    const state = stateByPositionId.get(position.positionId);

    if (!state) {
      await handleNewTraderPosition(
        trader,
        position,
        traderEquityFp9,
        subscriptions,
        stats
      );
      continue;
    }

    await handleIncreasedTraderPosition(
      trader,
      position,
      state,
      traderEquityFp9,
      subscriptions,
      stats
    );
  }
}

/**
 * Один цикл автокопирования: опрашивает активные позиции основного счета
 * каждого трейдера и сопоставляет их с сохранённым состоянием.
 */
export async function runCopyEngineCycle(): Promise<CopyEngineCycleStats> {
  const stats: CopyEngineCycleStats = {
    tradersProcessed: 0,
    copiesOpened: 0,
    copiesIncreased: 0,
    copiesClosed: 0,
    failures: 0,
    errors: [],
  };

  try {
    if (!(await isDatabaseAvailable())) {
      stats.errors.push("База данных недоступна — цикл пропущен.");
      return stats;
    }
  } catch {
    stats.errors.push("База данных недоступна — цикл пропущен.");
    return stats;
  }

  let users: BotUser[];

  try {
    users = await listBotUsers();
  } catch (error) {
    stats.errors.push(
      `Не удалось получить пользователей: ${describeError(error)}`
    );
    return stats;
  }

  const traders = users.filter((user) => user.role === "trader");
  const usersById = new Map(users.map((user) => [user.telegramId, user]));

  for (const trader of traders) {
    try {
      await syncTrader(trader, usersById, stats);
    } catch (error) {
      stats.errors.push(
        `Трейдер ${trader.telegramId}: ошибка цикла копирования: ${describeError(error)}`
      );
    }
  }

  return stats;
}
