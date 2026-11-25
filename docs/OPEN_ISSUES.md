# 未解决事项

本页记录官方接口能力、权限和真实环境的交付边界。PRD 原始要求保存在 [PRD](PRD.md)。平台密钥、应用审核和账号权限清单见 [平台接入清单](PLATFORMS.md)。

## 暂不可用的真实发布能力

| 平台 | 当前系统行为 | 所缺的条件 |
| --- | --- | --- |
| TikTok | 运行模拟任务，真实发布入口禁用。 | TikTok 官方仅接受符合 Intended Use 的 Direct Post 应用，并明确排除仅用于团队自有账号发布的内部工具。未审计的私密测试限制不能替代准入。只有平台确认该用例具备资格时，才可重新评估 `video.publish`、审计要求和官方界面规则。[官方准入规则](https://developers.tiktok.com/docs/en/content-sharing-guidelines#intended-use) |
| 微博 | 真实入口禁用。已有网站授权和受限分享契约的实现与模拟测试。 | 公开分享需登记安全域、实际含该域的分享链接、真实操作者 IP 以及在发布时告知。需要公司的可信入口和合法的数据处理方式。普通文字和单图需确认商业 REST 写入资格，尚缺可用于本网站应用的官方视频上传及审核查询契约。[分享](https://open.weibo.com/wiki/2/statuses/share)、[真实来源 IP 要求](https://www.weibo.com/openapi)、[商业 REST](https://open.weibo.com/wiki/Business_API%E6%96%87%E6%A1%A3) |
| 快手 | 真实上传及发布禁用。OAuth 与查询契约已编码，模拟任务可用。 | 官方上传说明给出 HTTP 网关。发布尚未公开的公司视频需要平台确认可用的官方 HTTPS 网关及上传契约。请向开放平台核实后再验证分片、封面和回执。[官方视频创建](https://open.kuaishou.com/platformDocs/openAbility/contentManagement/createAVideo) |

## 直发状态或规则有待确认

- **抖音普通代发的最终状态（P-2、P-3、R-1）**。官方视频、图文创建回执证明平台收到了投稿，后续还要审核。已查到的作品基础信息接口属于投稿任务场景，不能证明普通代发的最终审核状态。系统保存作品 ID 并显示「结果待核对」。需要用已开通的应用和账号核对通用审核查询、拒绝原因、可见性和分享链接，连同分片大小适用边界一起验收。[创建视频](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create)、[投稿任务查询](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/posting-task/video-basic-info)
- **丢失最终提交回执（P-3、R-1）**。X、Facebook、LinkedIn 等最终创建接口缺少可靠的请求幂等键或按原请求身份回读方式。创建可能已执行而回执丢失时，系统用已有官方 ID 查询状态，无法确认时标记「结果待核对」，保留记录并阻止自动重发。Instagram 与 Threads 在容器返回 `PUBLISHED` 时可确认已发，若最终响应丢失且容器未返回帖子 ID，记录可能没有可访问链接。[X 创建](https://docs.x.com/x-api/posts/create-post)、[Facebook Page Feed](https://developers.facebook.com/docs/graph-api/reference/page/feed/)、[Threads 容器查询](https://developers.facebook.com/documentation/threads/reference/publishing)
- **Facebook、LinkedIn 和微信视频号的文案规则（C-3、S-4）**。Facebook Feed 和微信视频号桌面端的通用正文上限没有找到当前官方公开数值。LinkedIn `3000` 采用 PRD 中的配置，现行 Posts API 的实际限制和 share URN 的页面链接需使用有权账号验收。[Facebook Feed](https://developers.facebook.com/docs/graph-api/reference/page/feed/)、[LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-11)、[视频号助手](https://channels.weixin.qq.com/)
- **Meta 持续授权与媒体（U-3、P-2）**。Threads 私密账号的授权有效期不会因刷新而延长。当前接口无法可靠判断账号公开性，统一按原授权日起 90 天提醒。Facebook 视频与封面、Instagram 的媒体容器和限流实际额度，以及 `S3_PROVIDER_ENDPOINT` 的出站可达性需要真实环境验收。[Threads 长期令牌](https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens)、[Instagram 发布](https://developers.facebook.com/documentation/instagram-platform/content-publishing)、[Facebook 视频](https://developers.facebook.com/docs/graph-api/reference/page/videos/)
- **YouTube 可见性和平台发布资格（P-2、R-1）**。需要确认频道权限、自定义封面资格、OAuth 同意屏校验、超出默认配额时的 API 审核和竖版短视频实际分类。视频在本地接受并上传后，公开范围和 Shorts 分类由 YouTube 判定。[YouTube 上传](https://developers.google.com/youtube/v3/docs/videos/insert) · [2026 年 11 月合规变更](https://developers.google.com/youtube/data/revision_history?hl=en)
- **哔哩哔哩和 Bluesky 回执（P-2、R-1）**。在实际账号上验证 B 站分区 ID、稿件审核状态与可访问 BV/av 链接。Bluesky 视频补测账号邮箱验证、上传配额、处理和实际帖子链接。[B 站稿件查询](https://open.bilibili.com/doc/4/d9554788-dcef-f139-6217-b487d41c3826)、[Bluesky 视频上传](https://docs.bsky.app/docs/about-bluesky-content/video)

## 真实验收与部署条件

- 每个需要真实直发的应用由公司提供登记主体、回调地址、账号管理员、已获批的 scope 和实际测试权限。需在获准的测试账号逐个验证发布、已知失败、状态查询、重新授权以及结果不明时的重复发送保护。各平台申请提交、审计通过和生产上线均待公司确认。
- PRD 的官号全量实测、2 GB 素材与弱网断点恢复、跨境出口、实际操作时长和桌面浏览器兼容性仍需按公司目标环境验收。本地模拟和接口 fixture 用于验证业务流程与请求契约。
- 小红书与微信视频号的真实人工验收需要平台后台登录与编辑的实际操作。系统以授权编辑回填的官方帖子链接和实际文案为记录依据。
