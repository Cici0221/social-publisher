import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  const key = Buffer.from(raw ?? "", "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY 必须是 32 字节 Base64 密钥");
  return key;
}

export function encrypt(value: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decrypt(value: string, purpose: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("加密数据格式无效");
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  cipher.setAAD(Buffer.from(purpose));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64url")), cipher.final()]).toString("utf8");
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return [salt.toString("hex"), (await derive(password, salt)).toString("hex")].join(".");
}

export async function checkPassword(password: string, encoded?: string): Promise<boolean> {
  const [salt, hash] = (encoded ?? "").split(".");
  const expected = hash ? Buffer.from(hash, "hex") : Buffer.alloc(64);
  const actual = await derive(password, salt ? Buffer.from(salt, "hex") : Buffer.alloc(16));
  return timingSafeEqual(actual, expected) && Boolean(encoded);
}
