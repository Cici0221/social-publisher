import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { encrypt, hashPassword } from "../src/server/crypto";
import { audit } from "../src/server/audit";
import { memberSchema } from "../src/server/team";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const secret = process.env.BOOTSTRAP_ADMIN_TOTP_SECRET;
try {
  await db().preference.upsert({ where: { id: "workspace" }, create: {}, update: {} });
  if (email || password || secret) {
    const member = memberSchema.parse({ email, password, name: "系统管理员", role: "ADMIN" });
    if (!secret || !/^[A-Z2-7]{32,}$/i.test(secret)) throw new Error("初始管理员 TOTP 密钥无效。");
    await db().$transaction(async tx => {
      if (await tx.user.findFirst({ select: { id: true } })) return;
      const id = randomUUID();
      await tx.user.create({
        data: { id, email: member.email, role: member.role, name: member.name,
          passwordHash: await hashPassword(member.password), totpSecret: encrypt(secret, "totp:" + id) },
      });
      await audit(tx, id, "member.bootstrap", id, { role: member.role });
    }, { isolationLevel: "Serializable" });
  }
  console.info("工作台配置已初始化。");
} catch {
  console.error("初始配置失败，请核对数据库及 BOOTSTRAP_ADMIN 环境变量。");
  process.exitCode = 1;
} finally {
  await db().$disconnect();
}
