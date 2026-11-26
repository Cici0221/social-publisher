import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { recoverAdministrator, recoveryEmail } from "../src/server/credentials";
import { db } from "../src/server/db";
import { AppError } from "../src/server/errors";
import { validateRuntimeConfig } from "../src/server/runtime-config";

async function main() {
  const input = recoveryEmail.safeParse(process.argv[2]);
  if (!input.success || process.argv.length !== 3 || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AppError("请在私密交互式终端运行 npm run recover:admin -- <管理员邮箱>。");
  }
  validateRuntimeConfig();
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`将重置 ${input.data} 的密码与双重验证，并结束其所有会话。请输入该邮箱确认：`);
    if (answer.trim().toLowerCase() !== input.data) throw new AppError("邮箱不匹配，恢复已取消。");
  } finally {
    prompt.close();
  }
  const client = db();
  try {
    const credentials = await recoverAdministrator(input.data);
    console.info(`管理员凭据已重置，仅显示一次。\n临时密码：${credentials.password}\n验证器密钥：${credentials.secret}`);
  } finally {
    await client.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof AppError ? error.message : "恢复失败，请检查应用运行配置和数据库连接。");
  process.exitCode = 1;
}
