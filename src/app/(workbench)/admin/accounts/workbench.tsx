"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { isPlatform, languageLabels, platformRules, type Language, type PlatformKey } from "@/lib/platforms";
import type { AccountMode, AccountStatus } from "@/generated/prisma/enums";

type AccountRow = { id: string; name: string; platform: string; language: Language; expiresAt: string | null; mode: AccountMode; status: AccountStatus };
type Entry = { key: PlatformKey; available: boolean; reason?: string };
const languageChoices = Object.entries(languageLabels);
const accountMode: Record<AccountMode, string> = { LIVE: "官方授权", MANUAL: "人工登记", MOCK: "模拟账号" };
const statusLabels: Record<AccountStatus, string> = { ACTIVE: "有效", REAUTH_REQUIRED: "待重新授权", DISABLED: "已解绑" };

export function AccountWorkbench({ initial, providers, demo }: { initial: AccountRow[]; providers: Entry[]; demo: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<PlatformKey>("bluesky");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState("");
  const manual = platformRules[selected].mode === "manual";
  const capability = providers.find(provider => provider.key === selected);

  async function submit(path: string, data: object, method = "POST") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const result = await response.json() as { error?: string; url?: string };
      if (!response.ok) throw new Error(result.error ?? "保存失败。");
      if (result.url) window.location.assign(result.url);
      else { setConfirm(""); router.refresh(); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败。"); }
    finally { setBusy(false); }
  }

  function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (manual) void submit("/api/accounts", { action: "MANUAL", platform: selected, name: form.get("name"), language: form.get("language"),
      backendUrl: form.get("backendUrl") || undefined });
    else if (demo) void submit("/api/accounts", { action: "MOCK", platform: selected, name: form.get("name"), language: form.get("language") });
    else void submit("/api/accounts", { action: "AUTHORIZE", platform: selected });
  }

  return <>
    <form className="delivery-panel account-bind" onSubmit={bind}>
      <div><h2>{manual ? "登记半自动账号" : demo ? "添加模拟账号" : "绑定官方账号"}</h2>
        <p className="muted">{manual ? "填写账号名称，编辑会在平台官方后台完成人工发布。" : demo ? "演示任务不会向真实平台发送。" : "选择平台后，按官方流程授权。Bluesky 使用环境中配置的应用专用密码。"}</p></div>
      <div className="delivery-options">
        <label className="form-field"><span>平台</span><select value={selected} onChange={event => setSelected(event.target.value as PlatformKey)}>
          {providers.map(entry => <option key={entry.key} value={entry.key}>{platformRules[entry.key].label}</option>)}
        </select></label>
        {(demo || manual) && <>
          <label className="form-field"><span>账号名称</span><input name="name" required maxLength={80} placeholder="例如：宣传部演示账号" /></label>
          <label className="form-field"><span>默认语言</span><select name="language" defaultValue="ZH">
            {languageChoices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </>}
        {manual && <label className="form-field"><span>官方后台地址</span>
          <input key={selected} name="backendUrl" type="url" defaultValue={platformRules[selected].backend} />
        </label>}
      </div>
      {!demo && !manual && !capability?.available && <p className="delivery-errors">{capability?.reason ?? "官方接入不可用。"}</p>}
      <button className="button button-primary" disabled={busy || (!demo && !manual && !capability?.available)}> {manual ? "登记账号" : demo ? "新增模拟账号" : "前往授权"} </button>
    </form>
    <div className="delivery-stack">
      {initial.map(row => <article className="delivery-panel" key={row.id}>
        <header className="delivery-panel-heading"><div><h2>{isPlatform(row.platform) ? platformRules[row.platform].label : row.platform} · {row.name}</h2>
          <p className="muted">{accountMode[row.mode]}{row.expiresAt && ` · 到期 ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai",
            dateStyle: "medium", timeStyle: "short" }).format(new Date(row.expiresAt))}（北京时间）`}</p></div>
          <span className={row.status === "ACTIVE" ? "delivery-badge good" : "delivery-badge"}>{statusLabels[row.status]}</span>
        </header>
        {row.status !== "DISABLED" && <div className="delivery-options">
          <label className="form-field"><span>默认文案语言</span>
            <select value={row.language} disabled={busy} onChange={event => void submit(`/api/accounts/${row.id}`, { language: event.target.value }, "PATCH")}>
              {languageChoices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
          {confirm === row.id ? <div className="delivery-actions">
            <button className="button button-outline" type="button" onClick={() => setConfirm("")}>返回</button>
            <button className="button button-primary" disabled={busy} type="button"
              onClick={() => void submit(`/api/accounts/${row.id}`, { detach: true }, "PATCH")}>确认解绑</button>
          </div> : <button className="button button-outline" type="button" onClick={() => setConfirm(row.id)}>解绑</button>}
        </div>}
      </article>)}
    </div>
    {message && <p className="delivery-errors" role="alert">{message}</p>}
  </>;
}
