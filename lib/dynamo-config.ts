import { existsSync } from "node:fs";

/**
 * Резолвит конфигурацию подключения к DynamoDB-совместимому Document API.
 *
 * Если в окружении заданы внешние реквизиты (DOCUMENT_API_ENDPOINT и ключи,
 * например Yandex Cloud Document API) — они используются как раньше.
 * Если внешних реквизитов нет — подключение автоматически идёт к локальной
 * DynamoDB (сервис `dynamodb-local` в compose-сети или localhost:8000 на хосте).
 */
export function resolveDynamoConfig(): {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  isLocal: boolean;
} {
  const endpoint = process.env.DOCUMENT_API_ENDPOINT?.trim();

  if (endpoint) {
    return {
      endpoint,
      region: process.env.DOCUMENT_API_REGION ?? "ru-central1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
      isLocal: false,
    };
  }

  const localEndpoint =
    process.env.DYNAMODB_LOCAL_ENDPOINT?.trim() ||
    (existsSync("/.dockerenv")
      ? "http://dynamodb-local:8000"
      : "http://localhost:8000");

  return {
    endpoint: localEndpoint,
    region: process.env.DOCUMENT_API_REGION ?? "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
    isLocal: true,
  };
}
