import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { encrypt, hashPassword } from "../src/server/crypto";
import { audit } from "../src/server/audit";
import { ZodError } from "zod";
import { memberSchema } from "../src/server/team";
import { RuntimeConfigError, validateRuntimeConfig } from "../src/server/runtime-config";
import { bootstrapStorage } from "../src/server/assets/storage";
import { errorDetails, logError } from "../src/server/logging";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const secret = process.env.BOOTSTRAP_ADMIN_TOTP_SECRET;
let client: ReturnType<typeof db> | undefined;
try {
  validateRuntimeConfig();
  client = db();
  await client.preference.upsert({ where: { id: "workspace" }, create: {}, update: {} });
  if (email || password || secret) {
    const member = memberSchema.parse({ email, password, name: "系统管理员", role: "ADMIN" });
    if (!secret || !/^[A-Z2-7]{32,}$/i.test(secret)) throw new RuntimeConfigError("初始管理员 TOTP 密钥无效。");
    await client.$transaction(async tx => {
      if (await tx.user.findFirst({ select: { id: true } })) return;
      const id = randomUUID();
      await tx.user.create({
        data: { id, email: member.email, role: member.role, name: member.name,
          passwordHash: await hashPassword(member.password), totpSecret: encrypt(secret, "totp:" + id) },
      });
      await audit(tx, id, "member.bootstrap", id, { role: member.role });
    }, { isolationLevel: "Serializable" });
  }
  await bootstrapStorage();
  console.info("工作台配置已初始化。");
} catch (error) {
  logError("bootstrap.failed", {
    error: errorDetails(error),
    configuration: error instanceof RuntimeConfigError ? error.message : undefined,
    fields: error instanceof ZodError ? error.issues.map(issue => ({ path: issue.path, code: issue.code })) : undefined,
  });
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}
