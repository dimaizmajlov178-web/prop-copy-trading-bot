import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

/**
 * API-ключи UpScale хранятся защищённо: шифруются AES-256-GCM перед записью
 * в DynamoDB и расшифровываются только на сервере при вызовах UpScale API.
 * В чат ключи никогда не выводятся в открытом виде — только маскированные.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const ENCRYPTION_PREFIX = "v1:";

function getSecretKey(): Buffer {
  const secret =
    process.env.DATA_ENCRYPTION_KEY ??
    process.env.TELEGRAM_BOT_TOKEN ??
    "upscale-local-development-secret";

  return scryptSync(secret, "upscale-binding-encryption", 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getSecretKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error("Unsupported secret format");
  }

  const body = stored.slice(ENCRYPTION_PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split(":");

  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted secret");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    getSecretKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Маскирует API-ключ для отображения в чате: usk_1a2b…ef90. */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return "usk_****";
  return `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`;
}
