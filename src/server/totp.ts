import * as OTPAuth from "otpauth";

function totp(email: string, secret: string) {
  return new OTPAuth.TOTP({
    issuer: "一键发布",
    label: email,
    secret: OTPAuth.Secret.fromBase32(secret),
    period: 30,
    digits: 6,
    algorithm: "SHA1",
  });
}

export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function enrollmentUri(email: string, secret: string) {
  return totp(email, secret).toString();
}

export function validTotpStep(email: string, secret: string, token: string, timestamp = Date.now()): bigint | null {
  if (!/^\d{6}$/.test(token)) return null;
  const delta = totp(email, secret).validate({ token, timestamp, window: 1 });
  return delta === null ? null : BigInt(Math.floor(timestamp / 30_000) + delta);
}
