"use client";

import { useEffect, useId, useState } from "react";
import { Image as ImageIcon, Paperclip, Video, X } from "lucide-react";
import type { DraftCopy } from "@/lib/draft-schema";
import { formatBody, measureCopy, platformLimit, platformRules, type PlatformKey } from "@/lib/platforms";
import type { EditorAsset, listEditorAssets } from "@/server/drafts";
import styles from "../contents.module.css";

type AssetPage = Awaited<ReturnType<typeof listEditorAssets>>;

export function CopyCount({ copy, platform }: { copy: DraftCopy; platform: PlatformKey }) {
  const titleMax = platformLimit(platform, "title");
  const bodyMax = platformLimit(platform);
  const bodyCount = measureCopy(platform, formatBody(platform, copy));
  const titleCount = measureCopy(platform, copy.title, "title");
  const bodyUnit = platformRules[platform].body?.metric === "utf8" ? "字节" : "字";
  return <span className={styles.counts}>
    {titleMax !== null && <span data-over={titleCount > titleMax}>标题 {titleCount} / {titleMax}</span>}
    <span data-over={bodyMax !== null && bodyCount > bodyMax}>正文 {bodyCount}{bodyMax !== null ? ` / ${bodyMax}` : ""} {bodyUnit}</span>
  </span>;
}

function TagsField({ tags, onChange }: { tags: string[]; onChange: (value: string[]) => void }) {
  const [input, setInput] = useState(tags.join("，"));
  const parsed = [...new Set(input.split(/[,，\n]+/).map(tag => tag.trim()).filter(Boolean))];
  const invalid = parsed.length > 100 || parsed.some(tag => tag.length > 100);

  return <label className={styles.control}>
    <span>话题标签</span>
    <textarea rows={2} value={input} placeholder="用逗号或换行分隔" aria-invalid={invalid}
      onChange={event => {
        const value = event.currentTarget.value;
        setInput(value);
        const next = [...new Set(value.split(/[,，\n]+/).map(tag => tag.trim()).filter(Boolean))];
        if (next.length <= 100 && next.every(tag => tag.length <= 100) && next.join("\n") !== tags.join("\n")) onChange(next);
      }} />
    {invalid && <small role="alert">最多 100 个标签，每个标签最多 100 字符。</small>}
  </label>;
}

function AssetPicker({ selected, imageOnly = false, onSelect }: {
  selected: string[]; imageOnly?: boolean; onSelect: (asset: EditorAsset, checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<AssetPage | null>(null);
  const [error, setError] = useState("");
  const choiceName = useId();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({ page: String(page), q: query.trim() });
      if (imageOnly) params.set("kind", "image");
      try {
        const response = await fetch(`/api/drafts/assets?${params}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "暂时无法读取素材。");
        if (!controller.signal.aborted) setResult(data);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "暂时无法读取素材。");
      }
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, page, query, imageOnly, refresh]);

  function resetResult() {
    setError("");
    setResult(null);
  }

  function jump(next: number) {
    resetResult();
    setPage(next);
  }

  return <details className={styles.assetPicker} onToggle={event => {
    setOpen(event.currentTarget.open);
    resetResult();
  }}>
    <summary><Paperclip size={15} aria-hidden="true" /> {imageOnly ? "从素材库选择封面" : "从素材库选择"}</summary>
    <div className={styles.assetChooser}>
      <input type="search" aria-label={imageOnly ? "搜索封面图片名称" : "搜索素材名称"} placeholder="按文件名搜索"
        value={query} maxLength={100} onChange={event => { setQuery(event.currentTarget.value); jump(1); }} />
      {error && <p role="alert">{error}</p>}
      {!result && !error && <p role="status">正在读取素材…</p>}
      {result && <>
        <div className={styles.assetOptions}>
          {result.assets.map(asset => <label key={asset.id} className={styles.assetOption}>
            <input type={imageOnly ? "radio" : "checkbox"} name={choiceName} checked={selected.includes(asset.id)}
              disabled={!imageOnly && selected.length >= 100 && !selected.includes(asset.id)}
              onChange={event => onSelect(asset, event.currentTarget.checked)} />
            <span>{asset.filename}</span>
            {asset.kind === "VIDEO" ? <Video size={15} aria-label="视频" /> : <ImageIcon size={15} aria-label="图片" />}
          </label>)}
          {!result.assets.length && <p>没有匹配的素材。</p>}
        </div>
        {(page > 1 || result.hasMore) && <nav className={styles.pagination} aria-label={imageOnly ? "封面分页" : "草稿素材分页"}>
          <button className={styles.subtleButton} type="button" disabled={page <= 1} onClick={() => jump(page - 1)}>上一页</button>
          <span>第 {page} 页</span>
          <button className={styles.subtleButton} type="button" disabled={!result.hasMore} onClick={() => jump(page + 1)}>下一页</button>
        </nav>}
      </>}
      <div className={styles.formRow}>
        <a href="/assets" target="_blank" rel="noreferrer">在新标签页打开素材库</a>
        <button className={styles.subtleButton} type="button" disabled={!result && !error}
          onClick={() => { resetResult(); setRefresh(value => value + 1); }}>刷新素材列表</button>
      </div>
    </div>
  </details>;
}

function MediaField({ assets, selected, onChange, onChooseAsset }: {
  assets: EditorAsset[]; selected: string[]; onChange: (ids: string[]) => void; onChooseAsset: (asset: EditorAsset) => void;
}) {
  const items = new Map(assets.map(asset => [asset.id, asset]));

  return <div className={styles.mediaField}>
    <h3>素材</h3>
    {selected.length > 0 && <ul className={styles.attached} aria-label="已选素材">
      {selected.map(id => {
        const asset = items.get(id);
        const Icon = asset?.kind === "VIDEO" ? Video : ImageIcon;
        return <li key={id}>
          <span className={styles.assetPreview}>
            {asset?.hasThumbnail ? <img loading="lazy" src={`/api/assets/${id}/thumbnail`} alt="" />
              : <Icon size={20} aria-hidden="true" />}
          </span>
          <span title={asset?.filename}>{asset?.filename ?? "素材不可用"}</span>
          <button type="button" title="移除素材" aria-label={`移除${asset?.filename ?? "不可用素材"}`}
            onClick={() => onChange(selected.filter(value => value !== id))}><X size={14} aria-hidden="true" /></button>
        </li>;
      })}
    </ul>}
    <AssetPicker selected={selected} onSelect={(asset, checked) => {
      if (checked) onChooseAsset(asset);
      onChange(checked ? [...selected, asset.id] : selected.filter(id => id !== asset.id));
    }} />
  </div>;
}

export default function CopyFields({ copy, assets, onChange, onChooseAsset, platform, controlsId }: {
  copy: DraftCopy; assets: EditorAsset[]; onChange: (patch: Partial<DraftCopy>) => void;
  onChooseAsset: (asset: EditorAsset) => void; platform: PlatformKey | null; controlsId: string;
}) {
  const cover = assets.find(asset => asset.id === copy.coverId && asset.kind === "IMAGE");
  return <div id={controlsId} className={styles.copyFields} role="region" aria-label="文案编辑">
    <label className={styles.control}>
      <span>标题</span>
      <input value={copy.title} maxLength={500} placeholder="输入标题" onChange={event => onChange({ title: event.currentTarget.value })} />
    </label>
    <label className={styles.control}>
      <span>正文</span>
      <textarea value={copy.body} rows={9} maxLength={100_000} placeholder="撰写发布正文"
        onChange={event => onChange({ body: event.currentTarget.value })} />
    </label>
    <TagsField tags={copy.tags} onChange={tags => onChange({ tags })} />
    {platform && <div className={styles.copyCount}><CopyCount copy={copy} platform={platform} /></div>}
    <MediaField assets={assets} selected={copy.assetIds} onChange={assetIds => onChange({ assetIds })} onChooseAsset={onChooseAsset} />
    <div className={styles.mediaField}>
      <h3>视频封面</h3>
      <div className={styles.formRow}>
        <span className="muted">{copy.coverId ? cover?.filename ?? "封面不可用" : "未设置"}</span>
        {copy.coverId && <button className={styles.subtleButton} type="button" onClick={() => onChange({ coverId: null })}>移除封面</button>}
      </div>
      <AssetPicker selected={copy.coverId ? [copy.coverId] : []} imageOnly onSelect={asset => {
        onChooseAsset(asset);
        onChange({ coverId: asset.id });
      }} />
    </div>
  </div>;
}
