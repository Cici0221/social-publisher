# 一键发布

公司宣传部的多平台发布工作台。编辑准备素材和多语言文案，选择平台账号并一次提交。每个账号独立显示进度、失败原因和发布结果。系统需求和优先级以 [PRD](docs/PRD.md) 为准。平台接口、凭据和权限见 [14 平台接入清单](docs/PLATFORMS.md)，真实账号验收和能力限制见 [未解决事项](docs/OPEN_ISSUES.md)。

## 用 Docker Compose 本地启动

在仓库根目录运行。需要 Docker Engine 或 Docker Desktop，以及 Docker Compose。示例使用本机回环端口 `3000`（网页）、`55432`（PostgreSQL）、`56379`（Redis）和 `59000`（SeaweedFS）。

```sh
test -f .env || cp .env.example .env
docker compose up --build -d
docker compose ps
```

已构建应用镜像时，可运行 `docker compose up -d` 直接启动。等待 Web 服务就绪和 Worker 启动。从同一台机器打开 [工作台](http://localhost:3000)。Web 启动时运行 Prisma 迁移、初始化工作台和本地素材桶。需要排查时运行 `docker compose logs --tail 100 web worker`。`docker compose down` 停止应用，保留数据库、队列和素材卷。

### 首次登录

`.env.example` 中的初始管理员是 `admin@example.test`，密码是 `local-publisher-only`。它们只适用于本机空数据库的演示。登录还需要 6 位 TOTP 动态验证码。可把 `.env` 的 `BOOTSTRAP_ADMIN_TOTP_SECRET` 加入身份验证器，使用 SHA-1、30 秒周期。也可在本地演示时执行以下命令生成当前验证码。

```sh
docker compose exec -T web node --input-type=module -e 'import * as OTPAuth from "otpauth"; const secret = OTPAuth.Secret.fromBase32(process.env.BOOTSTRAP_ADMIN_TOTP_SECRET); console.log(new OTPAuth.TOTP({secret, algorithm: "SHA1", digits: 6, period: 30}).generate())'
```

Bootstrap 仅在用户表为空时建立初始管理员。更改 `.env` 中的初始账号配置不会更新已有账号。管理员可在成员管理创建编辑和审核人，并通过私下渠道把一次性登记信息交给相应成员。

### 修改和恢复登录凭据

成员可在「账号安全」使用当前密码和未使用的动态验证码修改密码或更换验证器。更换验证器时还需输入新验证器生成的验证码。保存后所有设备都要重新登录，请等到验证器显示下一组验证码。

成员忘记密码或丢失验证器时，管理员可在「成员管理」选择该成员的「重置凭据」，通过自己的密码和动态验证码分别重置密码或验证器。新凭据只在本次操作后显示，请私下交给对应成员。重置会结束该成员的所有会话。使用临时密码和验证码登录后，成员必须设置新密码，再重新登录工作台。

如果已无法登入工作台，拥有部署主机及应用数据库访问权限的运维人员可在私密交互式终端中恢复一个仍在职的管理员。使用 Compose 时，在仓库根目录运行以下命令，将示例邮箱替换成该管理员的邮箱。

```bash
docker compose exec web npm run recover:admin -- admin@example.test
```

直接运行应用时，载入部署所用的环境变量后执行 `npm run recover:admin -- admin@example.test`。输入目标邮箱确认后，命令会同时重置该管理员的密码和验证器，并结束其所有会话。临时密码和验证器密钥只显示一次。使用新密钥登记验证器后登录，按页面提示设置新密码。

### 跑一条模拟发布

1. 保留 `APP_MODE=local`，以及示例中留空的平台应用凭据。管理员在平台账号管理创建模拟账号，例如 Bluesky。
2. 创建草稿，填写文案，选择模拟账号。视频或图文任务可先在素材库上传文件，再从草稿选取。
3. 打开发布确认，核对账号、实际文案、素材和定时设置。提交后在进度页查看模拟回执。模拟回执不会生成真实帖子链接。
4. 管理员可在系统里开启审核。审核默认关闭。开启后编辑先提交审核，审核人通过后任务按原计划执行。使用专门的审核账号验证退回和通过。
5. 小红书和微信视频号使用半自动账号登记。任务就绪后可复制文案、下载 ZIP，并跳转到官方后台。演示时用自有测试链接验证回填，只有在有对应账号的发布授权并完成内容审核后，才在官方后台实际发表。

## 环境变量

Compose 在容器内将 `DATABASE_URL`、`REDIS_URL` 和 `S3_ENDPOINT` 指向 Compose 服务名。`.env.example` 中的回环地址用于从宿主机运行脚本、本地开发与测试。把自用 `.env` 留在服务器或本机。

| 变量 | 用途 |
| --- | --- |
| `APP_URL` | 浏览器实际使用的站点地址。决定请求来源校验、登录 Cookie 的 HTTPS 行为和平台 OAuth 回调地址。默认 `http://localhost:3000`。 |
| `APP_MODE` | `local` 用于本地模拟并关闭真实账号授权及发送。真实接入环境设为 `production`。为测试和生产使用独立的数据卷、数据库、Redis 和对象存储。 |
| `LOGIN_CLIENT_IP_HEADER` | 生产必填，例如 `X-Real-IP`。反向代理须覆盖客户端传入的同名头并写入单一真实 IP，同时限制用户只能经代理访问 Web。应用在校验密码前按来源及来源与邮箱组合限流。每个 Web 进程最多同时执行两次登录密码校验，本机模式也适用。 |
| `ENCRYPTION_KEY` | 32 字节随机数据的 Base64。用于平台凭据、任务中的敏感平台状态和 TOTP 密钥，Web 与 Worker 必须一致。生产可用 `openssl rand -base64 32` 生成。现有加密记录需要原密钥才能解开，生产中应妥善保管并备份密钥。 |
| `BOOTSTRAP_ADMIN_EMAIL`、`BOOTSTRAP_ADMIN_PASSWORD`、`BOOTSTRAP_ADMIN_TOTP_SECRET` | 空数据库的初始管理员配置。启用时填写全部三项，使用独立密码和至少 32 个字符的 Base32 TOTP 密钥。成功建立生产管理员后，可移除三项并保留正式管理员的身份验证器。 |
| `POSTGRES_PASSWORD`、`DATABASE_URL` | Compose 初始 PostgreSQL 密码和后端数据库连接地址。已有 PostgreSQL 实例需单独变更实际数据库密码。 |
| `REDIS_URL` | Web/Worker 发布队列所连 Redis 地址。支持 `redis://` 和 `rediss://`。生产用受控连接并将 Redis 留在内部网络。 |
| `S3_IMAGE` | 可选。指定已经准备好的 SeaweedFS 兼容镜像，默认 `chrislusf/seaweedfs:4.55`。 |
| `S3_ENDPOINT` | Worker 与 Web 读写素材使用的对象存储地址。 |
| `S3_PUBLIC_ENDPOINT` | 浏览器上传分片使用的可达地址。对象存储允许 `APP_URL` 的 Origin 发起签名 PUT 请求并暴露 `ETag`。生产使用 HTTPS。 |
| `S3_PROVIDER_ENDPOINT` | 平台需要主动拉取素材时使用的 HTTPS 签名地址。Facebook 视频、Instagram 和 Threads 的相应路径依赖第三方网络可访问的端点。生产将素材桶保持私有，按任务签发短期对象访问链接。 |
| `S3_BUCKET`、`S3_REGION`、`S3_FORCE_PATH_STYLE` | 素材桶、签名区域和路径风格开关。非本地环境预先建桶并配置权限。 |
| `S3_ACCESS_KEY`、`S3_SECRET_KEY` | 有权在对应桶进行对象读写及管理分片上传的存储凭据。Compose 示例值只用于本机 SeaweedFS。 |
| `MOCK_FAIL_PLATFORM` | 仅 `APP_MODE=local` 有效。设为平台键（如 `x`）可模拟单平台拒绝，用于失败隔离验收。普通演示留空。 |
| `TEST_BASE_URL` | HTTP 集成测试使用的本机 URL。常规运行无需配置。 |

各平台专用变量、OAuth 权限、应用审核和官方文档入口见 [平台接入清单](docs/PLATFORMS.md)。OAuth 平台需把 `APP_URL` 加 `/api/accounts/oauth/<平台键>` 注册为准确回调地址。回调必须返回同一个站点来源，管理员需保留工作台登录状态完成平台授权。

### 清理草稿和素材

在草稿编辑页删除自己的草稿或已退回内容，会解除该草稿的素材引用。审核和操作记录保留。素材原件在素材库由上传者或管理员单独删除。未编辑完、待审核或仍有待处理、可重试任务的内容会阻止删除所引用的素材。

当引用内容均已提交，且任务均已成功或取消，可在素材库明确确认清理原件和缩略图。系统保留发布文案、帖子链接和任务记录。引用该原件的历史半自动素材包将无法下载，从发布历史复制草稿时会略过已清理的素材。对象存储开启版本控制时，由存储的生命周期规则清理旧版本。

## 真实接入环境

- 宣传部工作台部署在公司的受控网络内，经 HTTPS 访问。按需要安排平台 OAuth 回调的可达性。为生产单独配置强密码、TOTP 密钥、加密密钥和对象存储凭据。
- Web 和 Worker 使用同一个 PostgreSQL、Redis、素材桶和 `ENCRYPTION_KEY`。数据库和 Redis 不对互联网开放。可为海外平台和国内平台分别安排受控出口，跨境素材范围和存储位置由公司确认。
- 新增一个平台的真实绑定前，先核对平台允许的测试账号、账号持有人授权和目标可见范围。先在独立环境使用模拟账号。在真实验收环境只配置此次获批的平台和测试账号，经业务授权后再提交测试内容。
- 小红书和微信视频号的发布动作由操作者在平台官方后台完成。X、Meta 等渠道可能消耗平台配额或费用。发帖前核对确认页中的账号、文案、素材、可见范围和时间。
- 当创建请求已发出但未收到可核验回执时，任务显示「结果待核对」。到官方后台核对该账号和作品。系统只允许对确认未发出或明确拒绝的失败任务执行单账号重试。

## 开发与测试

GitHub Actions 在推送和拉取请求时单独执行类型检查、单元测试和生产构建。集成测试使用临时 PostgreSQL、Redis 和 SeaweedFS，仅运行本地模拟发布，审核测试使用独立数据库，任务结束后清理测试数据卷。

本机开发还需要 Node.js `22.18+` 和可执行的 `ffmpeg`、`ffprobe`。先按上面的 Compose 命令启动基础设施，或在只运行源码 Web 和 Worker 时使用 `docker compose up -d db redis s3`。从仓库根目录运行。

```sh
npm ci
npm exec -- prisma generate
npm run db:deploy
npm run bootstrap
npm run dev
```

在另一终端运行 `npm run worker`。CI 或本地预检运行以下步骤。平台适配器 fixture 测试使用模拟响应。集成测试仅用于带样例初始管理员的本机演示环境。

```sh
npm run typecheck
npm test
npm run build
npm exec -- tsx test/integration/auth.ts
npm exec -- tsx test/integration/asset-multipart.ts
npm exec -- tsx test/integration/draft-store.ts
npm exec -- tsx test/integration/manual-delivery.ts
npm exec -- tsx test/integration/all-platforms.ts
```

14 平台联提测试使用审核关闭、未开启模拟失败的正常 Worker，并通过本机 S3 上传合成视频和封面。它验证 12 个模拟直发回执，以及两个官方后台的素材包和链接回填。运行 HTTP 集成测试前确保本机 Web 已启动。测试用带随机后缀的账号与数据，保留数据库中不可删改的操作日志。单平台失败隔离测试要求审核默认关闭，并使用专用 Worker。在本机源码环境的另一终端运行以下命令，其中第一个命令会持续运行，直到验收结束。

```sh
MOCK_FAIL_PLATFORM=x npm run worker
npm exec -- tsx test/integration/publish-queue.ts
```

定时重启测试会自行启动临时 Worker，应先停掉其他测试 Worker，再运行 `npm exec -- tsx test/integration/schedule-guard.ts`。审核集成测试使用独立本机 PostgreSQL 数据库，数据库名须以 `publisher_review_` 开头。先用目标连接运行 `npm run db:deploy`，再用 `REVIEW_TEST_DATABASE_URL` 指向它并执行 `npm exec -- tsx test/integration/review-flow.ts`。单元、模拟接口与本地集成结果不证明真实平台授权、审核或实际发布通过，真实验收项见 [未解决事项](docs/OPEN_ISSUES.md)。

## 代码入口

- `src/app` 提供简体中文工作台与 Next.js API。
- `prisma` 管理 PostgreSQL 模型和迁移。每个内容与账号的组合有唯一任务，任务状态和定时信息保留在数据库中。
- `src/worker` 运行 BullMQ、定时扫描与凭据维护。关闭工作台页面后任务继续运行。
- `src/lib/platforms.ts` 保存平台的文案、素材和发布设置规则。`src/platforms` 定义统一接口及各平台适配器。
- `src/server/assets` 管理 S3 分片上传、素材和缩略图。`docs/PRD.md` 保存原需求编号。
