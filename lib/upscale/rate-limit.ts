/**
 * Ограничитель запросов к UpScale API на ключ: отдельно на чтение и запись —
 * 10 запросов/сек и 60 запросов/мин. Скользящее окно, без плавающей точки.
 */
const MAX_PER_SECOND = 10;
const MAX_PER_MINUTE = 60;
const SECOND_WINDOW_MS = 1_000;
const MINUTE_WINDOW_MS = 60_000;

interface RateBucket {
  timestamps: number[];
}

const globalForLimiter = globalThis as unknown as {
  _upscaleRateBuckets: Map<string, RateBucket> | undefined;
};

function getBuckets(): Map<string, RateBucket> {
  if (!globalForLimiter._upscaleRateBuckets) {
    globalForLimiter._upscaleRateBuckets = new Map<string, RateBucket>();
  }
  return globalForLimiter._upscaleRateBuckets;
}

function getBucket(kind: "read" | "write", apiKey: string): RateBucket {
  const buckets = getBuckets();
  const key = `${kind}:${apiKey}`;

  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }

  return bucket;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 1)));
}

/**
 * Резервирует слот запроса и при необходимости ожидает,
 * пока не будут превышены лимиты 10/сек и 60/мин.
 */
export async function acquireRateLimitSlot(
  apiKey: string,
  kind: "read" | "write"
): Promise<void> {
  const bucket = getBucket(kind, apiKey);

  for (;;) {
    const now = Date.now();

    while (
      bucket.timestamps.length > 0 &&
      bucket.timestamps[0] <= now - MINUTE_WINDOW_MS
    ) {
      bucket.timestamps.shift();
    }

    if (bucket.timestamps.length >= MAX_PER_MINUTE) {
      const oldest = bucket.timestamps[0];
      await sleep(oldest + MINUTE_WINDOW_MS - now + 1);
      continue;
    }

    const secondCutoff = now - SECOND_WINDOW_MS;
    let recentIndex = bucket.timestamps.length;

    while (
      recentIndex > 0 &&
      bucket.timestamps[recentIndex - 1] > secondCutoff
    ) {
      recentIndex--;
    }

    const recentCount = bucket.timestamps.length - recentIndex;

    if (recentCount >= MAX_PER_SECOND) {
      const oldestRecent = bucket.timestamps[recentIndex];
      await sleep(oldestRecent + SECOND_WINDOW_MS - now + 1);
      continue;
    }

    bucket.timestamps.push(now);
    return;
  }
}

/**
 * Разбирает заголовок Retry-After (секунды или HTTP-дата) в миллисекунды ожидания.
 * null — заголовок отсутствует или не распознан.
 */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;

  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Number.isNaN(seconds) ? null : seconds * 1_000;
  }

  const date = Date.parse(trimmed);

  if (Number.isNaN(date)) return null;

  const delta = date - Date.now();
  return delta > 0 ? delta : 0;
}
