"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, CloudCheck, CloudUpload } from "lucide-react";
import {
  draftLanguages, emptyDraftCopy, resolveDraftCopy, restoreDraftCopy, updateDraftCopy,
  type Draft, type DraftLanguage,
} from "@/lib/draft-schema";
import { languageLabels, platformKeys, platformRules, type PlatformKey } from "@/lib/platforms";
import type { draftEditorResources, findDraft } from "@/server/drafts";
import CopyFields from "./copy-fields";
import PlatformPicker from "./platform-picker";
import styles from "../contents.module.css";

type InitialDraft = NonNullable<Awaited<ReturnType<typeof findDraft>>>;
type Resources = Awaited<ReturnType<typeof draftEditorResources>>;
type SaveFailure = { message: string; conflict: boolean };

const saveDelay = 650;

export default function DraftComposer({ initial, accounts, assets, presets }: Resources & { initial: InitialDraft }) {
  const [editor, setEditor] = useState({ draft: initial.draft, generation: 0 });
  const [saved, setSaved] = useState({ revision: initial.revision, generation: 0 });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [language, setLanguage] = useState<DraftLanguage>("ZH");
  const [platformTab, setPlatformTab] = useState<PlatformKey | null>(null);
  const [reset, setReset] = useState(0);
  const requestInFlight = useRef(false);
  const draft = editor.draft;
  const dirty = editor.generation !== saved.generation;

  function update(recipe: (previous: Draft) => Draft) {
    setEditor(previous => {
      const next = recipe(previous.draft);
      return next !== previous.draft ? { draft: next, generation: previous.generation + 1 } : previous;
    });
  }

  useEffect(() => {
    if (!dirty || saving || failure || requestInFlight.current) return;
    const timer = window.setTimeout(async () => {
      requestInFlight.current = true;
      setSaving(true);
      try {
        const response = await fetch(`/api/drafts/${initial.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: saved.revision, draft: editor.draft }),
        });
        const result = await response.json();
        if (!response.ok) {
          setFailure({ message: result.error ?? "保存失败，请重试。", conflict: response.status === 409 });
          return;
        }
        setSaved({ revision: result.revision, generation: editor.generation });
      } catch {
        setFailure({ message: "网络连接中断，修改仍保留在当前页面。", conflict: false });
      } finally {
        requestInFlight.current = false;
        setSaving(false);
      }
    }, saveDelay);
    return () => window.clearTimeout(timer);
  }, [dirty, saving, failure, editor, saved.revision, initial.id]);

  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const selectedIds = new Set(draft.selections.map(selection => selection.accountId));
  const selectedPlatforms = platformKeys.filter(platform => accounts.some(account => account.platform === platform && selectedIds.has(account.id)));
  const platform = platformTab && selectedPlatforms.includes(platformTab) ? platformTab : null;
  const copy = (platform ? resolveDraftCopy(draft, platform, language) : draft.versions[language]) ?? emptyDraftCopy();
  const overridden = platform ? Boolean(draft.overrides[platform]?.[language]) : false;

  return <div className={`page-container ${styles.page}`}>
    <a className={styles.back} href="/contents"><ArrowLeft size={17} aria-hidden="true" /> 返回草稿箱</a>
    <header className={styles.heading}>
      <div><h1>编辑草稿</h1><p>{draft.versions.ZH.title.trim() || "未命名草稿"}</p></div>
      <div className={styles.saveState} role="status" aria-live="polite">
        {failure ? <><CircleAlert size={17} aria-hidden="true" /><span>修改尚未保存</span></>
          : dirty ? <><CloudUpload size={17} aria-hidden="true" /><span>{saving ? "正在保存" : "等待保存"}</span></>
            : <><CloudCheck size={17} aria-hidden="true" /><span>{saved.generation ? "已自动保存" : "草稿已保存"}</span></>}
      </div>
      {!dirty && !failure && draft.selections.length > 0 && <a className="button button-primary" href={`/contents/${initial.id}/publish`}>核对发布清单</a>}
    </header>
    {initial.status === "RETURNED" && <div className={styles.notice}>
      <strong>审核退回</strong><span>{initial.reviewNote || "请修改后重新提交。"}</span>
    </div>}
    {failure && <div className={`${styles.notice} ${styles.error}`} role="alert">
      <span>{failure.message}</span>
      {failure.conflict ? <a className={styles.subtleButton} href={`/contents/${initial.id}`} target="_blank" rel="noreferrer">在新标签页查看保存版本</a>
        : <button className={styles.subtleButton} type="button" onClick={() => setFailure(null)}>重试保存</button>}
    </div>}
    <div className={styles.editorGrid}>
      <section className={styles.copyPanel} aria-label="编辑内容">
        <div className={styles.panelHeader}><h2>文案与素材</h2></div>
        <div className={styles.scopeTabs} role="group" aria-label="选择文案平台">
          <button type="button" aria-pressed={!platform} aria-controls="copy-fields" onClick={() => setPlatformTab(null)}>通用内容</button>
          {selectedPlatforms.map(value => <button key={value} type="button" aria-pressed={platform === value}
            aria-controls="copy-fields" onClick={() => setPlatformTab(value)}>{platformRules[value].label}</button>)}
        </div>
        <div className={styles.languageTabs} role="group" aria-label="选择编辑语言">
          {draftLanguages.map(value => <button key={value} type="button" aria-pressed={language === value}
            aria-controls="copy-fields" onClick={() => setLanguage(value)}>{languageLabels[value]}</button>)}
        </div>
        {platform && <div className={styles.overrideState}>
          <span>{overridden ? "已单独改写" : "继承通用内容 · 编辑后独立保存"}</span>
          {overridden && <button className={styles.subtleButton} type="button" onClick={() => {
            update(previous => restoreDraftCopy(previous, platform, language));
            setReset(value => value + 1);
          }}>恢复通用</button>}
        </div>}
        <CopyFields key={`${platform ?? "common"}/${language}/${reset}`} controlsId="copy-fields" copy={copy} assets={assets}
          onChange={patch => update(previous => updateDraftCopy(previous, platform, language, patch))} platform={platform} />
      </section>
      <PlatformPicker draft={draft} accounts={accounts} presets={presets}
        update={recipe => update(previous => ({ ...previous, selections: recipe(previous.selections) }))} />
    </div>
  </div>;
}
