import { docClient } from "./db";
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { TableName, IndexName } from "./schema";

export type BotRole = "owner" | "admin" | "trader" | "member";

export interface BotUser {
  telegramId: string;
  username?: string;
  /** Отображаемое имя (тег), задаётся при добавлении. */
  tag?: string;
  role: BotRole;
  /** Дата окончания доступа в формате YYYY-MM-DD (UTC), включительно. */
  accessExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export async function getBotUser(telegramId: string): Promise<BotUser | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.BOT_USERS,
      Key: { telegramId },
    })
  );
  return (result.Item as BotUser) ?? null;
}

export async function putBotUser(user: BotUser): Promise<BotUser> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.BOT_USERS,
      Item: user,
    })
  );
  return user;
}

export async function upsertBotUser(
  telegramId: string,
  data: {
    username?: string;
    tag?: string;
    role?: BotRole;
    accessExpiresAt?: string;
  }
): Promise<BotUser> {
  const now = new Date().toISOString();

  const exprNames: Record<string, string> = {
    ...(data.tag !== undefined ? { "#tag": "tag" } : {}),
    ...(data.role !== undefined ? { "#role": "role" } : {}),
  };

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TableName.BOT_USERS,
      Key: { telegramId },
      UpdateExpression:
        "set createdAt = if_not_exists(createdAt, :now), updatedAt = :now" +
        (data.username !== undefined ? ", username = :username" : "") +
        (data.tag !== undefined ? ", #tag = :tag" : "") +
        (data.role !== undefined ? ", #role = :role" : "") +
        (data.accessExpiresAt !== undefined
          ? ", accessExpiresAt = :accessExpiresAt"
          : ""),
      ...(Object.keys(exprNames).length > 0
        ? { ExpressionAttributeNames: exprNames }
        : {}),
      ExpressionAttributeValues: {
        ":now": now,
        ...(data.username !== undefined ? { ":username": data.username } : {}),
        ...(data.tag !== undefined ? { ":tag": data.tag } : {}),
        ...(data.role !== undefined ? { ":role": data.role } : {}),
        ...(data.accessExpiresAt !== undefined
          ? { ":accessExpiresAt": data.accessExpiresAt }
          : {}),
      },
      ReturnValues: "ALL_NEW",
    })
  );

  return result.Attributes as BotUser;
}

export async function listBotUsers(): Promise<BotUser[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TableName.BOT_USERS,
    })
  );
  return (result.Items as BotUser[]) ?? [];
}

export interface Service {
  id: string;
  name: string;
  description?: string;
  status: "active" | "inactive" | "deploying";
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export async function getServiceById(id: string): Promise<Service | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.SERVICES,
      Key: { id },
    })
  );
  return (result.Item as Service) ?? null;
}

export async function getServicesByStatus(status: string): Promise<Service[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.SERVICES,
      IndexName: IndexName.SERVICES_STATUS,
      KeyConditionExpression: "#status = :status",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": status,
      },
    })
  );
  return (result.Items as Service[]) ?? [];
}

export async function getAllServices(): Promise<Service[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TableName.SERVICES,
    })
  );
  return (result.Items as Service[]) ?? [];
}

export async function createService(
  data: Omit<Service, "createdAt" | "updatedAt">
): Promise<Service> {
  const now = new Date().toISOString();
  const service: Service = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: TableName.SERVICES,
      Item: service,
    })
  );

  return service;
}

export async function updateService(
  id: string,
  data: Partial<Pick<Service, "name" | "description" | "status" | "url">>
): Promise<Service> {
  const updateExpr = [];
  const exprValues: Record<string, unknown> = {};
  const exprNames: Record<string, string> = {};

  if (data.name !== undefined) {
    updateExpr.push("#name = :name");
    exprValues[":name"] = data.name;
    exprNames["#name"] = "name";
  }

  if (data.description !== undefined) {
    updateExpr.push("#description = :description");
    exprValues[":description"] = data.description;
    exprNames["#description"] = "description";
  }

  if (data.status !== undefined) {
    updateExpr.push("#status = :status");
    exprValues[":status"] = data.status;
    exprNames["#status"] = "status";
  }

  if (data.url !== undefined) {
    updateExpr.push("#url = :url");
    exprValues[":url"] = data.url;
    exprNames["#url"] = "url";
  }

  updateExpr.push("updatedAt = :updatedAt");
  exprValues[":updatedAt"] = new Date().toISOString();

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TableName.SERVICES,
      Key: { id },
      UpdateExpression: `set ${updateExpr.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ExpressionAttributeNames:
        Object.keys(exprNames).length > 0 ? exprNames : undefined,
      ReturnValues: "ALL_NEW",
    })
  );

  return result.Attributes as Service;
}

export async function deleteService(id: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.SERVICES,
      Key: { id },
    })
  );
}

export type UpscaleBindingKind = "primary" | "additional";

/** Снимок счета UpScale, найденного по API-ключу. */
export interface UpscaleAccountInfo {
  accountId: string;
  /** Фаза счета (например, Phase 1 / Funded). */
  phase?: string;
  /** Статус счета, если возвращает API. */
  status?: string;
  /** Баланс — исходная строка fp9 (значение × 10⁹). */
  balanceFp9: string | null;
  /** Эквити — исходная строка fp9 (значение × 10⁹). */
  equityFp9: string | null;
  /** Включена ли API-торговля на счете. */
  apiTrading: boolean;
}

/** Привязка API-ключа UpScale участника (основной или дополнительный счет). */
export interface UpscaleBinding {
  telegramId: string;
  bindingId: string;
  kind: UpscaleBindingKind;
  /** Зашифрованный API-ключ (AES-256-GCM), никогда не выводится в чат. */
  apiKeyEncrypted: string;
  /** Маскированное представление ключа для отображения в чате. */
  apiKeyMasked: string;
  accounts: UpscaleAccountInfo[];
  createdAt: string;
  updatedAt: string;
}

/** Временное состояние диалога бота (например, ожидание ввода API-ключа). */
export interface BotState {
  telegramId: string;
  awaiting?: string;
  createdAt: string;
  updatedAt: string;
}

export async function putUpscaleBinding(
  binding: UpscaleBinding
): Promise<UpscaleBinding> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.UPSCALE_BINDINGS,
      Item: binding,
    })
  );
  return binding;
}

export async function listUpscaleBindings(
  telegramId: string
): Promise<UpscaleBinding[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.UPSCALE_BINDINGS,
      KeyConditionExpression: "telegramId = :telegramId",
      ExpressionAttributeValues: { ":telegramId": telegramId },
    })
  );
  return (result.Items as UpscaleBinding[]) ?? [];
}

export async function getUpscaleBinding(
  telegramId: string,
  bindingId: string
): Promise<UpscaleBinding | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.UPSCALE_BINDINGS,
      Key: { telegramId, bindingId },
    })
  );
  return (result.Item as UpscaleBinding) ?? null;
}

export async function deleteUpscaleBinding(
  telegramId: string,
  bindingId: string
): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.UPSCALE_BINDINGS,
      Key: { telegramId, bindingId },
    })
  );
}

export async function deleteUpscaleBindingsByKind(
  telegramId: string,
  kind: UpscaleBindingKind
): Promise<void> {
  const bindings = await listUpscaleBindings(telegramId);
  await Promise.all(
    bindings
      .filter((binding) => binding.kind === kind)
      .map((binding) => deleteUpscaleBinding(telegramId, binding.bindingId))
  );
}

export async function getBotState(
  telegramId: string
): Promise<BotState | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.BOT_STATES,
      Key: { telegramId },
    })
  );
  return (result.Item as BotState) ?? null;
}

export async function putBotState(state: BotState): Promise<BotState> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.BOT_STATES,
      Item: state,
    })
  );
  return state;
}

export async function deleteBotState(telegramId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.BOT_STATES,
      Key: { telegramId },
    })
  );
}

/** Снимок статистики основного счета трейдера (GET /accounts/{accountId}/stats). */
export interface TraderStats {
  traderTelegramId: string;
  /** Основной счет трейдера, по которому получена статистика. */
  primaryAccountId: string | null;
  /** Число закрытых позиций (сделок). */
  positionsCount: number | null;
  /** Винрейт — исходная строка fp9 (значение × 10⁹). */
  winRateFp9: string | null;
  /** Средний RR (riskRewardRatio) — исходная строка fp9. */
  riskRewardRatioFp9: string | null;
  /** Среднее время удержания позиции (секунды) — исходная строка fp9. */
  avgPositionHoldTimeFp9: string | null;
  /** Топ-актив по числу/объему сделок. */
  topAsset: string | null;
  /** Есть ли вообще закрытые сделки у трейдера. */
  hasStats: boolean;
  /** Число скопированных сделок, учтённых ботом. */
  botTradesCount?: number;
  /** Прибыльные скопированные сделки (PnL > 0). */
  botWins?: number;
  /** Убыточные скопированные сделки (PnL < 0). */
  botLosses?: number;
  /** Средний RR скопированных сделок (fp9), null — RR не определён. */
  botAvgRrFp9?: string | null;
  /** Среднее время удержания скопированных сделок (fp9-секунды). */
  botAvgHoldTimeFp9?: string | null;
  /** Топ-актив скопированных сделок. */
  botTopAsset?: string | null;
  fetchedAt: string;
  updatedAt: string;
}

export async function getTraderStats(
  traderTelegramId: string
): Promise<TraderStats | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.TRADER_STATS,
      Key: { traderTelegramId },
    })
  );
  return (result.Item as TraderStats) ?? null;
}

export async function putTraderStats(stats: TraderStats): Promise<TraderStats> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.TRADER_STATS,
      Item: stats,
    })
  );
  return stats;
}

/**
 * Подписка участника на трейдера: участник копирует позиции трейдера
 * на своих дополнительных счетах с коэффициентом (например, "2", "1", "0.5").
 * Основной счет подписчика не копируется.
 */
export interface TraderSubscription {
  /** Telegram ID подписчика (участника). */
  subscriberTelegramId: string;
  /** Telegram ID трейдера, на которого подписались. */
  traderTelegramId: string;
  /** Коэффициент копирования — строка (например, "2", "1", "0.5", "1.25"). */
  coefficient: string;
  createdAt: string;
  updatedAt: string;
}

export async function putTraderSubscription(
  subscription: TraderSubscription
): Promise<TraderSubscription> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.SUBSCRIPTIONS,
      Item: subscription,
    })
  );
  return subscription;
}

export async function getTraderSubscription(
  subscriberTelegramId: string,
  traderTelegramId: string
): Promise<TraderSubscription | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.SUBSCRIPTIONS,
      Key: { subscriberTelegramId, traderTelegramId },
    })
  );
  return (result.Item as TraderSubscription) ?? null;
}

export async function listTraderSubscriptions(
  subscriberTelegramId: string
): Promise<TraderSubscription[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.SUBSCRIPTIONS,
      KeyConditionExpression: "subscriberTelegramId = :subscriberTelegramId",
      ExpressionAttributeValues: {
        ":subscriberTelegramId": subscriberTelegramId,
      },
    })
  );
  return (result.Items as TraderSubscription[]) ?? [];
}

export async function countTraderSubscribers(
  traderTelegramId: string
): Promise<number> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.SUBSCRIPTIONS,
      IndexName: IndexName.SUBSCRIPTIONS_TRADER,
      KeyConditionExpression: "traderTelegramId = :traderTelegramId",
      ExpressionAttributeValues: {
        ":traderTelegramId": traderTelegramId,
      },
      Select: "COUNT",
    })
  );
  return result.Count ?? 0;
}

export async function updateTraderSubscription(
  subscriberTelegramId: string,
  traderTelegramId: string,
  coefficient: string
): Promise<TraderSubscription> {
  const now = new Date().toISOString();

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TableName.SUBSCRIPTIONS,
      Key: { subscriberTelegramId, traderTelegramId },
      UpdateExpression:
        "set coefficient = :coefficient, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)",
      ExpressionAttributeValues: {
        ":coefficient": coefficient,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    })
  );

  return result.Attributes as TraderSubscription;
}

export async function deleteTraderSubscription(
  subscriberTelegramId: string,
  traderTelegramId: string
): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.SUBSCRIPTIONS,
      Key: { subscriberTelegramId, traderTelegramId },
    })
  );
}

/** Подписки на указанного трейдера (GSI trader-index, полные элементы). */
export async function listSubscriptionsByTrader(
  traderTelegramId: string
): Promise<TraderSubscription[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.SUBSCRIPTIONS,
      IndexName: IndexName.SUBSCRIPTIONS_TRADER,
      KeyConditionExpression: "traderTelegramId = :traderTelegramId",
      ExpressionAttributeValues: {
        ":traderTelegramId": traderTelegramId,
      },
    })
  );
  return (result.Items as TraderSubscription[]) ?? [];
}

/**
 * Сохранённое состояние открытой позиции трейдера — используется движком
 * копирования, чтобы отличать новые позиции от уже обработанных и замечать
 * увеличение (рост size/version).
 */
export interface TraderPositionState {
  traderTelegramId: string;
  /** ID позиции у трейдера (GET /positions/{accountId}/active). */
  positionId: string;
  marketId: string | null;
  asset: string | null;
  side: "buy" | "sell" | null;
  /** Резерв позиции в USD — исходная строка fp9. */
  traderAmountFp9: string;
  /** Размер позиции в базовом активе — исходная строка fp9. */
  traderSizeFp9: string | null;
  /** Ревизия позиции из API (растёт при каждом событии). */
  version: number | null;
  firstSeenAt: string;
  updatedAt: string;
}

export async function putTraderPositionState(
  state: TraderPositionState
): Promise<TraderPositionState> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.TRADER_POSITIONS,
      Item: state,
    })
  );
  return state;
}

export async function listTraderPositionStates(
  traderTelegramId: string
): Promise<TraderPositionState[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.TRADER_POSITIONS,
      KeyConditionExpression: "traderTelegramId = :traderTelegramId",
      ExpressionAttributeValues: {
        ":traderTelegramId": traderTelegramId,
      },
    })
  );
  return (result.Items as TraderPositionState[]) ?? [];
}

export async function deleteTraderPositionState(
  traderTelegramId: string,
  positionId: string
): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.TRADER_POSITIONS,
      Key: { traderTelegramId, positionId },
    })
  );
}

export type CopyPositionStatus =
  "pending" | "open" | "closing" | "closed" | "failed";

/**
 * Копия позиции трейдера на дополнительном счете подписчика.
 * copyId детерминирован (trader:position:account), поэтому повторный опрос
 * не создает дубликаты копий.
 */
export interface CopyPosition {
  copyId: string;
  traderTelegramId: string;
  traderPositionId: string;
  subscriberTelegramId: string;
  /** Дополнительный счет подписчика, на котором открыта копия. */
  copyAccountId: string;
  /** Привязка (bindingId), по ключу которой отправляется ордер. */
  bindingId: string;
  status: CopyPositionStatus;
  /** Идемпотентный ключ ордера открытия (x-idempotency-key). */
  openIdempotencyKey: string | null;
  /** Идемпотентный ключ ордера закрытия (x-idempotency-key). */
  closeIdempotencyKey: string | null;
  /** Ожидающее увеличения копии: объём дельты в USD (fp9), ещё не подтверждённый API. */
  pendingIncreaseFp9: string | null;
  /** Идемпотентный ключ ордера увеличения (x-idempotency-key). */
  pendingIncreaseIdempotencyKey: string | null;
  /** Суммарно отправленный резерв в USD (fp9). */
  appliedAmountFp9: string;
  /** Размер копии в базовом активе (fp9) — для закрытия take-ордером. */
  copySizeFp9: string | null;
  /** ID позиции-копии, зафиксированный чтением активных позиций. */
  copyPositionId: string | null;
  coefficient: string;
  marketId: string | null;
  asset: string | null;
  side: "buy" | "sell" | null;
  /** Цена открытия копии (fp9), фиксируется при чтении активных позиций. */
  openPriceFp9: string | null;
  stopTriggerPriceFp9: string | null;
  takeTriggerPriceFp9: string | null;
  createdAt: string;
  updatedAt: string;
  openedAt: string | null;
  closedAt: string | null;
  failureReason: string | null;
}

export async function putCopyPosition(
  copy: CopyPosition
): Promise<CopyPosition> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.COPY_POSITIONS,
      Item: copy,
    })
  );
  return copy;
}

export async function getCopyPosition(
  copyId: string
): Promise<CopyPosition | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.COPY_POSITIONS,
      Key: { copyId },
    })
  );
  return (result.Item as CopyPosition) ?? null;
}

/** Копии указанной позиции трейдера (GSI trader-position-index). */
export async function listCopyPositionsByTraderPosition(
  traderTelegramId: string,
  traderPositionId: string
): Promise<CopyPosition[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.COPY_POSITIONS,
      IndexName: IndexName.COPY_POSITIONS_TRADER_POSITION,
      KeyConditionExpression:
        "traderTelegramId = :traderTelegramId AND traderPositionId = :traderPositionId",
      ExpressionAttributeValues: {
        ":traderTelegramId": traderTelegramId,
        ":traderPositionId": traderPositionId,
      },
    })
  );
  return (result.Items as CopyPosition[]) ?? [];
}

/** Копии подписчика по всем его дополнительным счетам (GSI subscriber-index). */
export async function listCopyPositionsBySubscriber(
  subscriberTelegramId: string
): Promise<CopyPosition[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.COPY_POSITIONS,
      IndexName: IndexName.COPY_POSITIONS_SUBSCRIBER,
      KeyConditionExpression: "subscriberTelegramId = :subscriberTelegramId",
      ExpressionAttributeValues: {
        ":subscriberTelegramId": subscriberTelegramId,
      },
    })
  );
  return (result.Items as CopyPosition[]) ?? [];
}

export async function deleteCopyPosition(copyId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.COPY_POSITIONS,
      Key: { copyId },
    })
  );
}

/**
 * Настройки дневного лимита просадки участника: процент от счета, который
 * участник готов потерять за день, и поведение при срабатывании лимита.
 */
export interface DrawdownSettings {
  telegramId: string;
  /** Дневной лимит просадки в процентах (строка, например "2.5"); null — лимит не задан. */
  dailyLimitPercent: string | null;
  /** Закрывать открытые копии (close-all) при срабатывании лимита. */
  closePositionsOnBreach: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function getDrawdownSettings(
  telegramId: string
): Promise<DrawdownSettings | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.DRAWDOWN_SETTINGS,
      Key: { telegramId },
    })
  );
  return (result.Item as DrawdownSettings) ?? null;
}

export async function putDrawdownSettings(
  settings: DrawdownSettings
): Promise<DrawdownSettings> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.DRAWDOWN_SETTINGS,
      Item: settings,
    })
  );
  return settings;
}

/**
 * Состояние срабатывания дневного лимита просадки на конкретном счете.
 * Привязано к торговому дню (UTC): на следующий день срабатывание
 * сбрасывается и копирование возобновляется.
 */
export interface DrawdownBreachState {
  telegramId: string;
  /** Счет, на котором сработал лимит (дополнительный счет для копирования). */
  accountId: string;
  /** Торговый день в формате YYYY-MM-DD (UTC), к которому привязано срабатывание. */
  tradingDay: string;
  /** Лимит в процентах, действовавший в момент срабатывания. */
  limitPercent: string;
  /** Эквити на начало дня (fp9) из статус-эндпоинта риска UpScale. */
  dayStartEquityFp9: string | null;
  /** Текущее эквити (fp9) в момент срабатывания. */
  currentEquityFp9: string | null;
  /** Требуется ли закрывать позиции при срабатывании. */
  closePositions: boolean;
  /** Отправлен ли POST /positions/{accountId}/close-all. */
  positionsClosed: boolean;
  triggeredAt: string;
  updatedAt: string;
}

export async function getDrawdownState(
  telegramId: string,
  accountId: string
): Promise<DrawdownBreachState | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TableName.DRAWDOWN_STATES,
      Key: { telegramId, accountId },
    })
  );
  return (result.Item as DrawdownBreachState) ?? null;
}

export async function putDrawdownState(
  state: DrawdownBreachState
): Promise<DrawdownBreachState> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.DRAWDOWN_STATES,
      Item: state,
    })
  );
  return state;
}

export async function deleteDrawdownState(
  telegramId: string,
  accountId: string
): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TableName.DRAWDOWN_STATES,
      Key: { telegramId, accountId },
    })
  );
}

export async function listDrawdownStates(
  telegramId: string
): Promise<DrawdownBreachState[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.DRAWDOWN_STATES,
      KeyConditionExpression: "telegramId = :telegramId",
      ExpressionAttributeValues: { ":telegramId": telegramId },
    })
  );
  return (result.Items as DrawdownBreachState[]) ?? [];
}

/** Результат учтённой скопированной сделки. */
export type TradeResult = "win" | "loss" | "unknown";

/**
 * Закрытая скопированная сделка: фиксируется движком копирования
 * при закрытии копии позиции трейдера.
 */
export interface Trade {
  /** Детерминированный ID = copyId (одна копия — одна сделка). */
  tradeId: string;
  traderTelegramId: string;
  subscriberTelegramId: string;
  /** Дополнительный счет подписчика, на котором торговала копия. */
  copyAccountId: string;
  marketId: string | null;
  asset: string | null;
  side: "buy" | "sell" | null;
  /** PnL закрытой копии в USD (fp9), null — не удалось определить из API. */
  pnlFp9: string | null;
  /** win/loss по знаку PnL; unknown — PnL недоступен. */
  result: TradeResult;
  /** RR сделки: |take − open| / |open − stop| (fp9), null — уровни неизвестны. */
  rrFp9: string | null;
  /** Время удержания копии (fp9-секунды), null — время открытия неизвестно. */
  holdTimeSecFp9: string | null;
  /** Суммарный объём копии в USD (fp9). */
  amountFp9: string | null;
  openedAt: string | null;
  closedAt: string;
  createdAt: string;
  updatedAt: string;
}

export async function putTrade(trade: Trade): Promise<Trade> {
  await docClient.send(
    new PutCommand({
      TableName: TableName.TRADES,
      Item: trade,
    })
  );
  return trade;
}

/** Последние сделки участника (GSI subscriber-index, новые первыми). */
export async function listTradesBySubscriber(
  subscriberTelegramId: string,
  limit = 20
): Promise<Trade[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.TRADES,
      IndexName: IndexName.TRADES_SUBSCRIBER,
      KeyConditionExpression: "subscriberTelegramId = :subscriberTelegramId",
      ExpressionAttributeValues: {
        ":subscriberTelegramId": subscriberTelegramId,
      },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (result.Items as Trade[]) ?? [];
}

/** Последние сделки трейдера (GSI trader-index, новые первыми). */
export async function listTradesByTrader(
  traderTelegramId: string,
  limit = 20
): Promise<Trade[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TableName.TRADES,
      IndexName: IndexName.TRADES_TRADER,
      KeyConditionExpression: "traderTelegramId = :traderTelegramId",
      ExpressionAttributeValues: {
        ":traderTelegramId": traderTelegramId,
      },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (result.Items as Trade[]) ?? [];
}
