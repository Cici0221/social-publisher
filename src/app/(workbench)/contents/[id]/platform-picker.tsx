"use client";

import { useState, type FormEvent } from "react";
import { Bookmark, ChevronDown, Globe, MapPin } from "lucide-react";
import { draftLanguages, resolveDraftCopy, type Draft, type DraftLanguage, type DraftSelection } from "@/lib/draft-schema";
import { languageLabels, platformKeys, platformRules, type PlatformKey } from "@/lib/platforms";
import type { draftEditorResources } from "@/server/drafts";
import { CopyCount } from "./copy-fields";
import styles from "../contents.module.css";

type Resources = Awaited<ReturnType<typeof draftEditorResources>>;
type Account = Resources["accounts"][number];
type Preset = Resources["presets"][number];
type SelectionUpdater = (recipe: (previous: DraftSelection[]) => DraftSelection[]) => void;

const platformRegions = [
  { value: "domestic", label: "国内", Icon: MapPin },
  { value: "international", label: "海外", Icon: Globe },
] as const;

function accountIssue(account: Account) {
  if (account.status === "DISABLED") return "账号已停用";
  return account.available ? null : "授权已过期或需要重新绑定";
}

function PresetPicker({ presets: initial, activeIds, onApply }: {
  presets: Preset[]; activeIds: string[]; onApply: (ids: string[]) => boolean;
}) {
  const [presets, setPresets] = useState(initial);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeIds.length || !name.trim() || saving) return;
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/drafts/presets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, accountIds: activeIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const saved = data as Preset;
      setPresets(previous => [...previous.filter(preset => preset.id !== saved.id), saved]
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")));
      setName("");
      setMessage("组合已保存。");
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : "组合保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return <details className={styles.presets}>
    <summary><Bookmark size={16} aria-hidden="true" /> 常用组合 <ChevronDown size={15} aria-hidden="true" /></summary>
    <div className={styles.presetForm}>
      {presets.length > 0 && <div className={styles.presetButtons} role="group" aria-label="应用常用组合">
        {presets.map(preset => <button key={preset.id} className={styles.subtleButton} type="button" onClick={() => {
          setError("");
          setMessage(onApply(preset.accountIds) ? "已应用组合，跳过了当前不可用的账号。" : "已应用组合。");
        }}>{preset.name}</button>)}
      </div>}
      <form className={styles.formRow} onSubmit={save}>
        <input aria-label="组合名称" value={name} maxLength={60} required placeholder="例如：国内全部"
          onChange={event => setName(event.currentTarget.value)} />
        <button className={styles.subtleButton} type="submit" disabled={!name.trim() || saving || !activeIds.length}>{saving ? "正在保存" : "保存组合"}</button>
      </form>
      {!activeIds.length && <small>勾选至少一个可用账号即可保存组合。</small>}
      {message && <p role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  </details>;
}

function PlatformRow({ platform, accounts, selected, draft, update }: {
  platform: PlatformKey; accounts: Account[]; selected: Map<string, DraftSelection>; draft: Draft; update: SelectionUpdater;
}) {
  const rule = platformRules[platform];

  function toggle(account: Account, checked: boolean) {
    update(previous => checked ? [...previous, { accountId: account.id }] : previous.filter(row => row.accountId !== account.id));
  }

  return <div className={styles.platformRow}>
    <h4>{rule.label}</h4>
    {accounts.length === 0 ? <label className={styles.disabledAccount}>
      <input type="checkbox" disabled aria-label={`${rule.label}无已绑定账号`} /> 未绑定账号
    </label> : accounts.map(account => {
      const selection = selected.get(account.id);
      const issue = accountIssue(account);
      const language = selection?.language ?? account.language;
      const copy = selection ? resolveDraftCopy(draft, platform, language) : undefined;
      return <div className={styles.account} key={account.id}>
        <label className={styles.accountChoice}>
          <input type="checkbox" checked={Boolean(selection)} disabled={Boolean(issue)}
            onChange={event => toggle(account, event.currentTarget.checked)} />
          <span>{account.name}</span>
          {account.mode !== "LIVE" && <small>{account.mode === "MOCK" ? "模拟" : "半自动"}</small>}
        </label>
        {issue && <p className={styles.accountIssue}>{issue}</p>}
        {issue && selection && <button className={styles.subtleButton} type="button" onClick={() => toggle(account, false)}>移除该账号</button>}
        {selection && !issue && <div className={styles.accountContext}>
          <select aria-label={`${account.name}使用的语言版本`} value={selection.language ?? ""} onChange={event => {
            const next = event.currentTarget.value as DraftLanguage | "";
            update(previous => previous.map(row => row.accountId === account.id ? { ...row, language: next || undefined } : row));
          }}>
            <option value="">默认 · {languageLabels[account.language]}</option>
            {draftLanguages.map(value => <option key={value} value={value}>{languageLabels[value]}</option>)}
          </select>
          {copy ? <CopyCount copy={copy} platform={platform} />
            : <small className={styles.accountIssue}>{languageLabels[language]}文案尚未填写</small>}
        </div>}
      </div>;
    })}
  </div>;
}

export default function PlatformPicker({ draft, accounts, presets, update }: {
  draft: Draft; accounts: Account[]; presets: Preset[]; update: SelectionUpdater;
}) {
  const available = accounts.filter(account => account.available);
  const availableIds = new Set(available.map(account => account.id));
  const selected = new Map(draft.selections.map(row => [row.accountId, row]));
  const activeIds = draft.selections.filter(row => availableIds.has(row.accountId)).map(row => row.accountId);
  const all = available.length > 0 && activeIds.length === available.length;
  const missing = draft.selections.filter(row => !accounts.some(account => account.id === row.accountId));

  function apply(ids: string[]) {
    const ready = ids.filter(id => availableIds.has(id));
    if (ready.length || !ids.length) update(previous => {
      const existing = new Map(previous.map(row => [row.accountId, row]));
      return ready.map(accountId => existing.get(accountId) ?? { accountId });
    });
    return ready.length !== ids.length;
  }

  return <aside className={styles.platformPanel} aria-label="发布账号">
    <div className={styles.panelHeader}>
      <h2>发布账号</h2>
      <span>{draft.selections.length} 个已选</span>
    </div>
    <PresetPicker presets={presets} activeIds={activeIds} onApply={apply} />
    <label className={styles.selectAll}>
      <input type="checkbox" checked={all} disabled={!available.length} onChange={event => {
        const shouldSelect = event.currentTarget.checked;
        update(previous => {
          if (!shouldSelect) return previous.filter(row => !availableIds.has(row.accountId));
          const existing = new Set(previous.map(row => row.accountId));
          return [...previous, ...available.filter(account => !existing.has(account.id)).map(account => ({ accountId: account.id }))];
        });
      }} /> 全选可用账号
    </label>
    {missing.length > 0 && <div className={styles.missing}>
      <span>有 {missing.length} 个已选账号已移除。</span>
      <button className={styles.subtleButton} type="button" onClick={() => {
        const missingIds = new Set(missing.map(row => row.accountId));
        update(previous => previous.filter(row => !missingIds.has(row.accountId)));
      }}>清理已移除账号</button>
    </div>}
    {platformRegions.map(({ value, label, Icon }) => <section className={styles.region} key={value}>
      <h3><Icon size={15} aria-hidden="true" /> {label}</h3>
      {platformKeys.filter(platform => platformRules[platform].region === value).map(platform =>
        <PlatformRow key={platform} platform={platform} draft={draft} selected={selected} update={update}
          accounts={accounts.filter(account => account.platform === platform)} />)}
    </section>)}
  </aside>;
}
