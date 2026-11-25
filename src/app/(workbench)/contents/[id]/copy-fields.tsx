"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Image as ImageIcon, Paperclip, Video, X } from "lucide-react";
import type { DraftCopy } from "@/lib/draft-schema";
import { formatBody, measureCopy, platformLimit, platformRules, type PlatformKey } from "@/lib/platforms";
import type { draftEditorResources } from "@/server/drafts";
import styles from "../contents.module.css";

type Asset = Awaited<ReturnType<typeof draftEditorResources>>["assets"][number];

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

function MediaField({ assets, selected, onChange }: {
  assets: Asset[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(24);
  const items = new Map(assets.map(asset => [asset.id, asset]));
  const shown = assets.filter(asset => asset.filename.toLowerCase().includes(query.trim().toLowerCase()));

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
    <details className={styles.assetPicker}>
      <summary><Paperclip size={15} aria-hidden="true" /> 从素材库选择</summary>
      <div className={styles.assetChooser}>
        {assets.length ? <>
          <input aria-label="搜索素材名称" placeholder="按文件名搜索" value={query}
            onChange={event => { setQuery(event.currentTarget.value); setLimit(24); }} />
          <div className={styles.assetOptions}>
            {shown.slice(0, limit).map(asset => <label key={asset.id} className={styles.assetOption}>
              <input type="checkbox" checked={selected.includes(asset.id)}
                disabled={selected.length >= 100 && !selected.includes(asset.id)}
                onChange={event => onChange(event.currentTarget.checked ? [...selected, asset.id] : selected.filter(id => id !== asset.id))} />
              <span>{asset.filename}</span>
              {asset.kind === "VIDEO" ? <Video size={15} aria-label="视频" /> : <ImageIcon size={15} aria-label="图片" />}
            </label>)}
            {!shown.length && <p>没有匹配的素材。</p>}
          </div>
          {shown.length > limit && <button className={styles.subtleButton} type="button" onClick={() => setLimit(limit + 24)}>显示更多</button>}
        </> : <p>素材库暂无可用文件。</p>}
        <div className={styles.formRow}>
          <a href="/assets" target="_blank" rel="noreferrer">在新标签页打开素材库</a>
          <button className={styles.subtleButton} type="button" disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}>{refreshing ? "正在刷新" : "刷新素材列表"}</button>
        </div>
      </div>
    </details>
  </div>;
}

export default function CopyFields({ copy, assets, onChange, platform, controlsId }: {
  copy: DraftCopy; assets: Asset[]; onChange: (patch: Partial<DraftCopy>) => void;
  platform: PlatformKey | null; controlsId: string;
}) {
  const images = assets.filter(asset => asset.kind === "IMAGE");
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
    <MediaField assets={assets} selected={copy.assetIds} onChange={assetIds => onChange({ assetIds })} />
    <label className={styles.control}>
      <span>视频封面</span>
      <select value={copy.coverId ?? ""} onChange={event => onChange({ coverId: event.currentTarget.value || null })}>
        <option value="">未设置</option>
        {copy.coverId && !images.some(image => image.id === copy.coverId) && <option value={copy.coverId}>封面不可用</option>}
        {images.map(image => <option key={image.id} value={image.id}>{image.filename}</option>)}
      </select>
    </label>
  </div>;
}
