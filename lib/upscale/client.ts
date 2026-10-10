import { randomUUID } from "crypto";
import type { UpscaleAccountInfo } from "@/lib/models";
import { acquireRateLimitSlot, parseRetryAfterMs } from "./rate-limit";

export const UPSCALE_API_BASE =
  process.env.UPSCALE_API_BASE ?? "https://api.upscale.trade";

/** Максимальное ожидание по Retry-After при 429 (одна попытка повтора). */
const MAX_RETRY_AFTER_MS = 30_000;

/** Стабильные машинные коды ошибок UpScale API (поле error) → понятные сообщения. */
const MACHINE_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "API-ключ недействителен. Проверьте ключ и попробуйте снова.",
  invalid_api_key:
    "API-ключ недействителен. Проверьте ключ и попробуйте снова.",
  api_trading_not_enabled:
    "На счете не включена API-торговля. Включите её в UpScale и обновите привязку.",
  insufficient_balance:
    "Недостаточно свободных средств на счете для этой операции.",
  insufficient_margin: "Недостаточно маржи для этой операции.",
  market_paused: "Торговля по этому рынку временно приостановлена UpScale.",
  market_not_found: "Рынок не найден или недоступен для API-торговли.",
  market_closed: "Рынок сейчас закрыт — операция отложена.",
  invalid_amount: "UpScale отклонил объём операции как некорректный.",
  amount_too_small: "Объём меньше минимально допустимого для этого рынка.",
  invalid_leverage: "Недопустимое плечо для этого рынка.",
  position_not_found: "Позиция не найдена — возможно, она уже закрыта.",
  order_not_found: "Ордер не найден — возможно, он уже исполнен или отменён.",
  duplicate_idempotency_key:
    "Операция с таким идемпотентным ключом уже выполнялась.",
  rate_limit_exceeded: "Превышен лимит запросов к UpScale. Попробуйте позже.",
};

function userMessageForMachineError(machineError: string): string {
  return (
    MACHINE_ERROR_MESSAGES[machineError] ??
    "UpScale вернул ошибку. Проверьте корректность данных и попробуйте позже."
  );
}

/** Ошибка API UpScale с машинным кодом и понятным пользователю сообщением. */
export class UpscaleApiError extends Error {
  /** Стабильный машинный код ошибки из поля error ответа API (если есть). */
  code: string | null;
  userMessage: string;

  constructor(
    message: string,
    userMessage: string,
    code: string | null = null
  ) {
    super(message);
    this.name = "UpscaleApiError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

interface UpscaleAccountRaw {
  id?: string | number;
  accountId?: string | number;
  phase?: string;
  status?: string;
  balance?: string | number;
  equity?: string | number;
  apiTrading?: boolean;
  [key: string]: unknown;
}

interface RequestInitLike {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: string;
  idempotencyKey?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 1)));
}

/**
 * Выполняет запрос к UpScale API: соблюдает лимиты ключа (10/сек, 60/мин
 * отдельно на чтение и запись), при 429 уважает Retry-After (одна попытка
 * повтора), ошибки ветвит по машинному коду (error) в понятные сообщения.
 */
async function upscaleRequest(
  apiKey: string,
  path: string,
  init: RequestInitLike
): Promise<unknown> {
  const kind = init.method === "GET" ? "read" : "write";

  for (let attempt = 0; attempt < 2; attempt++) {
    await acquireRateLimitSlot(apiKey, kind);

    let response: Response;

    try {
      response = await fetch(`${UPSCALE_API_BASE}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.idempotencyKey
            ? { "x-idempotency-key": init.idempotencyKey }
            : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        cache: "no-store",
      });
    } catch (error) {
      console.error("UpScale API network error:", error);
      throw new UpscaleApiError(
        "UpScale network error",
        "Не удалось связаться с UpScale. Проверьте соединение и попробуйте позже."
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new UpscaleApiError(
        `UpScale auth failed (${response.status})`,
        "API-ключ недействителен или не имеет доступа к счетам. Проверьте ключ и включённую API-торговлю, затем попробуйте снова."
      );
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("Retry-After")
      );

      if (
        attempt === 0 &&
        retryAfterMs !== null &&
        retryAfterMs <= MAX_RETRY_AFTER_MS
      ) {
        await sleep(retryAfterMs + 250);
        continue;
      }

      throw new UpscaleApiError(
        "UpScale rate limit exceeded",
        "Слишком много запросов к UpScale. Подождите немного и попробуйте снова.",
        "rate_limit_exceeded"
      );
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const machineError =
        payload && typeof payload === "object"
          ? String((payload as Record<string, unknown>).error ?? "")
          : "";

      throw new UpscaleApiError(
        `UpScale API error ${response.status}: ${machineError || "unknown"}`,
        machineError
          ? userMessageForMachineError(machineError)
          : "UpScale вернул ошибку. Проверьте корректность API-ключа и попробуйте позже.",
        machineError || null
      );
    }

    return payload;
  }

  throw new UpscaleApiError(
    "UpScale rate limit exceeded",
    "Слишком много запросов к UpScale. Подождите немного и попробуйте снова.",
    "rate_limit_exceeded"
  );
}

/** Выполняет GET-запрос к UpScale API. */
async function upscaleGet(apiKey: string, path: string): Promise<unknown> {
  return upscaleRequest(apiKey, path, { method: "GET" });
}

function extractAccounts(payload: unknown): UpscaleAccountRaw[] {
  if (Array.isArray(payload)) return payload as UpscaleAccountRaw[];

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["accounts", "data", "items", "result"]) {
      if (Array.isArray(record[key])) return record[key] as UpscaleAccountRaw[];
    }
  }

  return [];
}

function toAccountId(raw: UpscaleAccountRaw): string | null {
  const value = raw.accountId ?? raw.id;
  if (value === undefined || value === null) return null;
  return String(value);
}

/** Запрашивает счета ключа: GET /accounts/with-risk-status. */
export async function fetchAccountsWithRiskStatus(
  apiKey: string
): Promise<UpscaleAccountInfo[]> {
  const payload = await upscaleGet(apiKey, "/accounts/with-risk-status");

  const accounts = extractAccounts(payload)
    .map((raw) => {
      const accountId = toAccountId(raw);
      if (!accountId) return null;

      return {
        accountId,
        phase: typeof raw.phase === "string" ? raw.phase : undefined,
        status: typeof raw.status === "string" ? raw.status : undefined,
        balanceFp9:
          raw.balance === undefined || raw.balance === null
            ? null
            : String(raw.balance),
        equityFp9:
          raw.equity === undefined || raw.equity === null
            ? null
            : String(raw.equity),
        apiTrading: raw.apiTrading === true,
      } as UpscaleAccountInfo;
    })
    .filter((account): account is UpscaleAccountInfo => account !== null);

  return accounts;
}

/** Агрегированная статистика закрытых позиций счета (GET /accounts/{accountId}/stats). */
export interface UpscaleAccountStats {
  positionsCount: number | null;
  winRateFp9: string | null;
  riskRewardRatioFp9: string | null;
  avgPositionHoldTimeFp9: string | null;
  topAsset: string | null;
}

function pickFp9(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

function pickString(
  raw: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function extractTopAsset(raw: Record<string, unknown>): string | null {
  const keys = ["topAsset", "topSymbol", "mostTradedAsset", "topMarket"];

  for (const key of keys) {
    const value = raw[key];

    if (typeof value === "string" && value.trim()) return value.trim();

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const inner of ["asset", "symbol", "market", "id", "name"]) {
        const candidate = record[inner];
        if (typeof candidate === "string" && candidate.trim()) {
          return candidate.trim();
        }
      }
    }
  }

  return null;
}

/** Запрашивает агрегированную статистику счета: GET /accounts/{accountId}/stats. */
export async function fetchAccountStats(
  apiKey: string,
  accountId: string
): Promise<UpscaleAccountStats> {
  const payload = await upscaleGet(
    apiKey,
    `/accounts/${encodeURIComponent(accountId)}/stats`
  );

  const raw =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const nested =
    raw.stats && typeof raw.stats === "object"
      ? (raw.stats as Record<string, unknown>)
      : {};
  const source = { ...raw, ...nested };

  const countRaw = pickFp9(source, [
    "positionsCount",
    "positions",
    "totalPositions",
    "closedPositions",
    "tradesCount",
    "trades",
  ]);
  const parsedCount = countRaw === null ? NaN : parseInt(countRaw, 10);

  return {
    positionsCount: Number.isNaN(parsedCount) ? null : parsedCount,
    winRateFp9: pickFp9(source, [
      "winRate",
      "winrate",
      "winRateFp9",
      "winPercent",
    ]),
    riskRewardRatioFp9: pickFp9(source, [
      "riskRewardRatio",
      "avgRiskRewardRatio",
      "averageRiskRewardRatio",
      "riskReward",
    ]),
    avgPositionHoldTimeFp9: pickFp9(source, [
      "avgPositionHoldTime",
      "averagePositionHoldTime",
      "avgHoldTime",
      "avgPositionHoldDuration",
    ]),
    topAsset: extractTopAsset(source),
  };
}

/** Открытая позиция UpScale (GET /positions/{accountId}/active). */
export interface UpscalePosition {
  positionId: string | null;
  marketId: string | null;
  asset: string | null;
  side: "buy" | "sell" | null;
  /** Резерв в USD — исходная строка fp9. */
  amountFp9: string | null;
  /** Размер позиции в базовом активе — исходная строка fp9. */
  sizeFp9: string | null;
  openPriceFp9: string | null;
  stopTriggerPriceFp9: string | null;
  takeTriggerPriceFp9: string | null;
  leverageFp9: string | null;
  /** Ревизия позиции (растёт при каждом событии). */
  version: number | null;
  /** Время открытия позиции (миллисекунды), если удалось распознать. */
  openedAtMs: number | null;
}

function extractPositionList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["positions", "data", "items", "result"]) {
      if (Array.isArray(record[key])) {
        return record[key] as Record<string, unknown>[];
      }
    }
  }

  return [];
}

function parseSide(raw: unknown): "buy" | "sell" | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["buy", "long", "b"].includes(normalized)) return "buy";
  if (["sell", "short", "s"].includes(normalized)) return "sell";
  return null;
}

function parseOpenedAtMs(raw: unknown): number | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();

    if (/^\d+$/.test(trimmed)) {
      const value = BigInt(trimmed);
      // fp9-секунды содержат 9 дробных разрядов — отличаем их от мс.
      if (trimmed.length > 12) {
        return Number(value / 1_000_000n) * 1_000;
      }
      return Number(value < 10_000_000_000n ? value * 1_000n : value);
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 10_000_000_000 ? raw * 1_000 : raw;
  }

  return null;
}

/** Запрашивает открытые позиции счета: GET /positions/{accountId}/active. */
export async function fetchActivePositions(
  apiKey: string,
  accountId: string
): Promise<UpscalePosition[]> {
  const payload = await upscaleGet(
    apiKey,
    `/positions/${encodeURIComponent(accountId)}/active`
  );

  return extractPositionList(payload).map((raw) => ({
    positionId: pickString(raw, ["positionId", "id"]),
    marketId: pickString(raw, ["marketId", "market", "market_id", "assetId"]),
    asset: pickString(raw, ["asset", "symbol", "market", "pair"]),
    side: parseSide(raw.side ?? raw.direction ?? raw.type),
    amountFp9: pickFp9(raw, ["amount", "marginAmount", "reserveAmount"]),
    sizeFp9: pickFp9(raw, ["size", "positionSize", "baseAmount", "quantity"]),
    openPriceFp9: pickFp9(raw, [
      "openPrice",
      "entryPrice",
      "openedPrice",
      "avgEntryPrice",
    ]),
    stopTriggerPriceFp9: pickFp9(raw, [
      "stopTriggerPrice",
      "stopLossPrice",
      "stopPrice",
    ]),
    takeTriggerPriceFp9: pickFp9(raw, [
      "takeTriggerPrice",
      "takeProfitPrice",
      "takePrice",
    ]),
    leverageFp9: pickFp9(raw, ["leverage", "leverageFp9"]),
    version:
      typeof raw.version === "number"
        ? raw.version
        : (() => {
            const rawVersion = pickFp9(raw, ["version", "revision"]);
            return rawVersion === null
              ? null
              : Number.parseInt(rawVersion, 10) || null;
          })(),
    openedAtMs: parseOpenedAtMs(
      raw.openedAt ?? raw.createdAt ?? raw.openTime ?? raw.opened_at
    ),
  }));
}

/** Тело ордера UpScale (POST /orders). */
export interface UpscaleOrderRequest {
  type: "market" | "take";
  marketId?: string;
  side?: "buy" | "sell";
  /** Резерв в USD (fp9) — для market-ордеров. */
  amount?: string;
  /** Плечо (fp9). */
  leverage?: string;
  /** Цена срабатывания для take-ордера ("0" — закрытие по рынку). */
  triggerPrice?: string;
  stopTriggerPrice?: string;
  takeTriggerPrice?: string;
}

/**
 * Создает ордер: POST /orders с обязательным заголовком x-idempotency-key.
 * Возвращает тело ответа либо null, если ответ не является объектом.
 */
export async function createOrder(
  apiKey: string,
  order: UpscaleOrderRequest,
  idempotencyKey: string
): Promise<Record<string, unknown> | null> {
  const payload = await upscaleRequest(apiKey, "/orders", {
    method: "POST",
    body: JSON.stringify(order),
    idempotencyKey: idempotencyKey || randomUUID(),
  });

  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : null;
}

/** Снимок риска счета: GET /accounts/risk-status (все счета ключа). */
export interface UpscaleRiskSnapshot {
  accountId: string;
  /** Эквити на начало торгового дня (fp9) — база дневной просадки. */
  dayStartEquityFp9: string | null;
  /** Текущее эквити (fp9). */
  currentEquityFp9: string | null;
}

/**
 * Запрашивает снимки риска по всем счетам ключа: GET /accounts/risk-status.
 * Возвращает dayStartEquity и currentEquity как строки fp9.
 */
export async function fetchRiskStatuses(
  apiKey: string
): Promise<UpscaleRiskSnapshot[]> {
  const payload = await upscaleGet(apiKey, "/accounts/risk-status");

  return extractAccounts(payload)
    .map((raw) => {
      const accountId = toAccountId(raw);
      if (!accountId) return null;

      // Поля риска могут быть как на верхнем уровне, так и во вложенном
      // объекте (risk / riskStatus) — объединяем источники.
      const nested = ["risk", "riskStatus"]
        .filter((key) => raw[key] && typeof raw[key] === "object")
        .reduce(
          (acc, key) => ({
            ...acc,
            ...(raw[key] as Record<string, unknown>),
          }),
          {} as Record<string, unknown>
        );
      const source = { ...raw, ...nested };

      return {
        accountId,
        dayStartEquityFp9: pickFp9(source, [
          "dayStartEquity",
          "dayStartEquityFp9",
          "day_start_equity",
        ]),
        currentEquityFp9: pickFp9(source, [
          "currentEquity",
          "currentEquityFp9",
          "current_equity",
          "equity",
        ]),
      } as UpscaleRiskSnapshot;
    })
    .filter((snapshot): snapshot is UpscaleRiskSnapshot => snapshot !== null);
}

/** Закрывает все позиции счета по рынку: POST /positions/{accountId}/close-all. */
export async function closeAllPositions(
  apiKey: string,
  accountId: string,
  idempotencyKey: string
): Promise<Record<string, unknown> | null> {
  const payload = await upscaleRequest(
    apiKey,
    `/positions/${encodeURIComponent(accountId)}/close-all`,
    {
      method: "POST",
      body: "{}",
      idempotencyKey: idempotencyKey || randomUUID(),
    }
  );

  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : null;
}

/**
 * История позиций счета: GET /positions/{accountId}/portfolio/history.
 * Формат элементов толерантно распознаётся, как и в остальных списках.
 */
export async function fetchPortfolioHistory(
  apiKey: string,
  accountId: string
): Promise<Record<string, unknown>[]> {
  const payload = await upscaleGet(
    apiKey,
    `/positions/${encodeURIComponent(accountId)}/portfolio/history`
  );

  return extractPositionList(payload);
}

/**
 * Ищет в истории портфеля закрытую позицию по id и извлекает её PnL (fp9).
 * Возвращает null, если позиция не найдена или PnL в ответе отсутствует.
 */
export async function fetchClosedPositionPnlFp9(
  apiKey: string,
  accountId: string,
  positionId: string
): Promise<string | null> {
  const items = await fetchPortfolioHistory(apiKey, accountId);

  const match = items.find(
    (item) =>
      pickString(item, ["positionId", "id", "position_id"]) === positionId
  );

  if (!match) return null;

  // PnL может лежать на верхнем уровне элемента или во вложенном объекте.
  const nested =
    match.result && typeof match.result === "object"
      ? (match.result as Record<string, unknown>)
      : {};
  const source = { ...match, ...nested };

  return pickFp9(source, [
    "pnl",
    "pnlFp9",
    "realizedPnl",
    "realizedPnlFp9",
    "netPnl",
    "profit",
    "realizedProfit",
    "closeProfit",
    "pnlUsd",
  ]);
}
