"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { languageLabels, platformRules, type PlatformOption } from "@/lib/platforms";
import { formatPublishTime, localPublishTimeToDate, publishTimeInput } from "@/lib/publish-time";
import { PublishZonePicker, usePublishZone } from "@/ui/publish-zone-picker";
import type { DraftSelection } from "@/lib/draft-schema";
import type { publicationPlan } from "@/server/publications";

type Plan = Awaited<ReturnType<typeof publicationPlan>>;
type OptionValue = boolean | string | number | undefined;

function OptionField({ option, value, change }: { option: PlatformOption; value: OptionValue; change: (value: OptionValue) => void }) {
  if (option.type === "check") return <label className="tick-field">
    <input type="checkbox" checked={value === true} onChange={event => change(event.target.checked)} /><span>{option.label}</span>
  </label>;
  if (option.type === "choice") return <label className="form-field"><span>{option.label}</span>
    <select value={String(value ?? "")} onChange={event => change(event.target.value || undefined)}>
      <option value="">请选择</option>{option.choices?.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select>
  </label>;
  return <label className="form-field"><span>{option.label}</span>
    <input type={option.type} min={option.min} maxLength={option.max} value={String(value ?? "")} onChange={event => {
      const input = event.target.value;
      change(!input ? undefined : option.type === "number" ? Number(input) : input);
    }} />
  </label>;
}

export function PublishReview({ plan }: { plan: Plan }) {
  const router = useRouter();
  const [selections, setSelections] = useState<DraftSelection[]>(plan.draft.selections);
  const [dirty, setDirty] = useState(false);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [zone, setZone] = usePublishZone();
  const [uniform, setUniform] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const valid = plan.rows.filter(row => !row.errors.length).length;
  const invalid = plan.rows.length - valid;
  const submitLabel = plan.reviewRequired ? "提交审核" : "一键发布";

  function change(accountId: string, name: string, value: OptionValue) {
    setSelections(current => current.map(selection => {
      if (selection.accountId !== accountId) return selection;
      const options = { ...selection.options };
      if (value === undefined) delete options[name];
      else options[name] = value;
      return { ...selection, options };
    }));
    setDirty(true);
  }

  function applySchedule(value: string, accountId?: string) {
    const date = value ? localPublishTimeToDate(value, zone) : null;
    if (value && !date) {
      setMessage("请输入有效的定时时间。");
      return;
    }
    setSelections(current => current.map(selection => !accountId || selection.accountId === accountId
      ? { ...selection, runAt: date?.toISOString() ?? null } : selection));
    setMessage("");
    setDirty(true);
  }

  async function act(save: boolean) {
    setWorking(true);
    setMessage("");
    try {
      const url = save ? `/api/drafts/${plan.id}` : `/api/publications/${plan.id}`;
      const body = save ? { revision: plan.revision, draft: { ...plan.draft, selections } } : { revision: plan.revision, skipInvalid };
      const response = await fetch(url, { method: save ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { href?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "操作未完成。");
      if (save) router.refresh();
      else router.push(result.href ?? `/contents/${plan.id}/progress`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作未完成。");
    } finally { setWorking(false); }
  }

  return <>
    {!plan.rows.length && <div className="delivery-empty">回到内容编辑页选择要发布的账号。</div>}
    {plan.rows.length > 0 && <section className="delivery-panel">
      <h2>发布时间</h2>
      <p className="muted">时间留空时立即执行。可以统一安排，也可以为每个账号分别设置。</p>
      <div className="delivery-options">
        <PublishZonePicker zone={zone} setZone={(value) => { setZone(value); setUniform(""); }} />
        <label className="form-field"><span>统一定时时间</span><input type="datetime-local" value={uniform}
          onChange={event => setUniform(event.target.value)} /></label>
        <button className="button button-outline" type="button" onClick={() => applySchedule(uniform)} disabled={!uniform}>
          应用到全部账号
        </button>
        <button className="button button-outline" type="button" onClick={() => { setUniform(""); applySchedule(""); }}>
          全部改为立即
        </button>
      </div>
    </section>}
    <div className="delivery-stack">
      {plan.rows.map(row => {
        const rule = row.platform ? platformRules[row.platform] : undefined;
        const selection = selections.find(item => item.accountId === row.accountId);
        return <article className="delivery-panel" key={row.accountId}>
          <header className="delivery-panel-heading"><div><h2>{rule?.label ?? "平台"} · {row.accountName}</h2>
            <p className="muted">{languageLabels[row.language]}{row.mode === "MOCK" ? " · 模拟" : row.mode === "MANUAL" ? " · 人工发布" : ""}</p></div>
            <span className={row.errors.length ? "delivery-badge danger" : "delivery-badge good"}>{row.errors.length ? "需要调整" : "校验通过"}</span>
          </header>
          {row.payload && <div className="delivery-copy">{rule?.title && row.payload.title && <strong>{row.payload.title}</strong>}
            {row.payload.body && <p>{row.payload.body}</p>}
            <small>{row.payload.assetIds.length} 项素材{row.payload.coverId && " · 已选封面"}</small>
          </div>}
          {row.errors.length > 0 && <ul className="delivery-errors">{row.errors.map(error => <li key={error}>{error}</li>)}</ul>}
          {row.warnings.length > 0 && <ul className="delivery-notes">{row.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
          {selection && <div className="delivery-options">
            <label className="form-field"><span>此账号的定时时间</span>
              <input type="datetime-local" value={selection.runAt ? publishTimeInput(new Date(selection.runAt), zone) : ""}
                onChange={event => applySchedule(event.target.value, row.accountId)} />
            </label>
            <span className="muted">{selection.runAt ? formatPublishTime(new Date(selection.runAt), zone) : "立即执行"}</span>
          </div>}
          {Boolean(rule?.options?.length) && <div className="delivery-options">
            {rule?.options?.map(option => <OptionField key={option.key} option={option} value={selection?.options?.[option.key] ?? option.default}
              change={value => change(row.accountId, option.key, value)} />)}
          </div>}
        </article>;
      })}
    </div>
    {plan.rows.length > 0 && <footer className="delivery-footer">
      <div><strong>{valid} 个账号可提交</strong>{invalid > 0 && <label className="tick-field">
        <input type="checkbox" checked={skipInvalid} onChange={event => setSkipInvalid(event.target.checked)} />
        <span>跳过 {invalid} 个未通过校验的账号</span></label>}</div>
      <div className="delivery-actions">
        {dirty && <button type="button" className="button button-outline" disabled={working} onClick={() => void act(true)}>保存设置并校验</button>}
        <button type="button" className="button button-primary" disabled={working || dirty || !valid || (invalid > 0 && !skipInvalid)}
          onClick={() => void act(false)}>{submitLabel}</button>
      </div>
    </footer>}
    {message && <p role="alert" className="delivery-errors">{message}</p>}
  </>;
}
