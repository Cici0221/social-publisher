import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { POST } from "../../src/app/api/auth/login/route";
import { digest } from "../../src/server/crypto";
import { db } from "../../src/server/db";
import { loginClientAddress } from "../../src/server/rate-limit";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://unconfigured");
if (process.env.APP_MODE !== "local" || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)) {
  throw new Error("Integration fixtures require a local environment");
}

const client = db();
const header = "x-qa-client-ip";
process.env.LOGIN_CLIENT_IP_HEADER = header;
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const subnet = randomBytes(2).toString("hex");
const addresses = [1, 2, 3].map(host => `2001:db8:${subnet}::${host}`);
const email = `qa-login-limits-${randomUUID()}@example.test`;
const body = JSON.stringify({ email, password: "incorrect fixture password", code: "000000" });
const keys = addresses.map(address => {
  const normalized = loginClientAddress(new Headers({ [header]: address }));
  return { source: digest(`login:address:${normalized}`), pair: digest(`login:account-address:${email}:${normalized}`) };
});
const login = (input: string, address?: string) => POST(new Request(origin + "/api/auth/login", {
  method: "POST", headers: {
    origin, "Content-Type": "application/json",
    "X-Forwarded-For": "192.0.2.9",
    ...(address ? { [header]: address } : {}),
  }, body: input,
}));

try {
  const expiresAt = new Date(Date.now() + 60_000);
  await client.loginLimit.createMany({ data: [
    { key: keys[0].source, count: 60, expiresAt },
    { key: keys[1].pair, count: 8, expiresAt },
  ] });
  assert.equal((await login("{", addresses[0])).status, 429, "source quota applies before JSON parsing");
  assert.equal((await login(body, addresses[1])).status, 429, "account-and-source quota is already exhausted");
  assert.equal((await login(body, addresses[2])).status, 401, "an exhausted quota does not block another source");
  assert.equal((await login(body)).status, 400, "the dedicated proxy header cannot be replaced by a forwarding header");
  console.info("通过：登录来源限流、来源与账号隔离，以及缺失代理专用头时拒绝请求。");
} finally {
  await client.loginLimit.deleteMany({ where: { key: { in: keys.flatMap(({ source, pair }) => [source, pair]) } } });
  await client.$disconnect();
}
