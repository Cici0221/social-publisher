"use client";

import {
  ArrowDownToLine, ArrowLeft, ArrowRight, CircleAlert, FileImage, Film, FolderPlus,
  HardDriveUpload, ImageIcon, Pause, Pencil, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssetList, AssetReference, AssetSummary } from "@/server/assets/service";
import { assetRequest, uploadAsset } from "./upload";
import styles from "./assets.module.css";

type Transfer = {
  id: string; file: File; progress: number;
  state: "queued" | "sending" | "done" | "paused" | "error";
  error?: string;
};
type Modal =
  | { type: "folder" }
  | { type: "edit"; asset: AssetSummary }
  | { type: "remove"; asset: AssetSummary; references: AssetReference[] };

const uploaderTypes = ".jpg,.jpeg,.png,.gif,.mp4,.mov";
const statusLabel = { READY: "可用", PROCESSING: "读取媒体信息中", FAILED: "无法使用", DELETED: "已删除" };
const transferLabel = { queued: "等待上传", sending: "上传中", done: "已上传", paused: "已暂停", error: "上传失败" };
const contentStatusLabel = { DRAFT: "草稿", IN_REVIEW: "待审核", RETURNED: "已退回", SUBMITTED: "已提交", DISCARDED: "已删除" };
const displayDate = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai",
  month: "2-digit", day: "2-digit", year: "numeric" });

function displayBytes(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + " KiB";
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " MiB";
  return (bytes / 1024 ** 3).toFixed(2) + " GiB";
}

function displayDuration(duration: number) {
  const seconds = Math.floor(duration);
  const units = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, "0"));
  return units.join(":");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

export function AssetLibrary({ initial, actorId, canManage }: {
  initial: AssetList; actorId: string; canManage: boolean;
}) {
  const [result, setResult] = useState(initial);
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [recentUpload, setRecentUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [modal, setModal] = useState<Modal | null>(null);
  const [modalError, setModalError] = useState("");
  const [saving, setSaving] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const filters = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dragCount = useRef(0);
  const busyRef = useRef(false);
  const controllers = useRef(new Map<string, AbortController>());
  const hasPendingMetadata = result.assets.some(asset => asset.status === "PROCESSING");

  useEffect(() => {
    const abort = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await assetRequest<AssetList>("/api/assets?" + query, abort.signal);
        if (!abort.signal.aborted) setResult(next);
      } catch (failure) {
        if (!abort.signal.aborted) setError(message(failure));
      } finally {
        fetching = false;
      }
    };
    void load();
    const poll = hasPendingMetadata || recentUpload ? setInterval(load, 2500) : undefined;
    return () => { abort.abort(); clearInterval(poll); };
  }, [query, refresh, hasPendingMetadata, recentUpload]);

  useEffect(() => {
    if (!recentUpload) return;
    const timeout = setTimeout(() => setRecentUpload(false), 15_000);
    return () => clearTimeout(timeout);
  }, [recentUpload]);

  useEffect(() => {
    if (modal && !dialog.current?.open) dialog.current?.showModal();
    if (!modal && dialog.current?.open) dialog.current.close();
  }, [modal]);

  function updateTransfer(id: string, update: Partial<Transfer>) {
    setTransfers(rows => rows.map(row => row.id === id ? { ...row, ...update } : row));
  }

  async function transfer(row: Transfer) {
    const abort = new AbortController();
    controllers.current.set(row.id, abort);
    updateTransfer(row.id, { state: "sending", error: undefined });
    try {
      await uploadAsset(actorId, row.file, abort.signal, progress => updateTransfer(row.id, { progress }));
      updateTransfer(row.id, { state: "done", progress: 100 });
      setRecentUpload(true);
      setRefresh(value => value + 1);
    } catch (failure) {
      updateTransfer(row.id, abort.signal.aborted ? { state: "paused" } : { state: "error", error: message(failure) });
    } finally {
      controllers.current.delete(row.id);
    }
  }

  async function runBatch(rows: Transfer[]) {
    busyRef.current = true;
    setBusy(true);
    let cursor = 0;
    const lane = async () => {
      while (cursor < rows.length) await transfer(rows[cursor++]);
    };
    try { await Promise.all([lane(), lane()]); }
    finally { busyRef.current = false; setBusy(false); }
  }

  function addFiles(files: FileList | null) {
    if (!files?.length || !canManage) return;
    if (busyRef.current) {
      setError("当前批次仍在上传，稍后可继续添加文件。");
      return;
    }
    setError("");
    const rows: Transfer[] = Array.from(files, (file, index) => ({
      id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${index}`,
      file, progress: 0, state: "queued",
    }));
    setTransfers(previous => [...previous.filter(row => row.state !== "done"), ...rows]);
    void runBatch(rows);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    const values = new URLSearchParams();
    for (const [key, raw] of input) {
      const value = String(raw).trim();
      if (value) values.set(key, value);
    }
    setError("");
    setQuery(values.toString());
    setRefresh(value => value + 1);
  }

  function jump(page: number) {
    const values = new URLSearchParams(query);
    values.set("page", String(page));
    setQuery(values.toString());
  }

  function open(next: Modal) {
    setModalError("");
    setModal(next);
  }

  async function inspectRemoval(asset: AssetSummary) {
    setError("");
    try {
      const { references } = await assetRequest<{ references: AssetReference[] }>(`/api/assets/${asset.id}`);
      open({ type: "remove", asset, references });
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || saving) return;
    const values = new FormData(event.currentTarget);
    setModalError("");
    setSaving(true);
    try {
      if (modal.type === "folder") {
        await assetRequest("/api/assets/folders", undefined, "POST", { name: String(values.get("name") ?? "") });
      } else if (modal.type === "edit") {
        const tags = String(values.get("tags") ?? "").split(/[、，,\n]+/u).map(value => value.trim()).filter(Boolean);
        await assetRequest(`/api/assets/${modal.asset.id}`, undefined, "PATCH",
          { tags, folderId: String(values.get("folder") ?? "") || null });
      } else {
        const archive = modal.references.length ? "?archivePublished=1" : "";
        const response = await fetch(`/api/assets/${modal.asset.id}${archive}`, { method: "DELETE" });
        const payload = await response.json() as { error?: string; references?: AssetReference[] };
        if (response.status === 409 && payload.references?.length) {
          setModal({ ...modal, references: payload.references });
          return;
        }
        if (!response.ok) throw new Error(payload.error ?? "素材无法删除。");
      }
      setModal(null);
      setRefresh(value => value + 1);
    } catch (failure) {
      setModalError(message(failure));
    } finally {
      setSaving(false);
    }
  }

  const lastPage = Math.max(1, Math.ceil(result.total / result.limit));
  const activeModalTitle = modal?.type === "folder" ? "新建素材文件夹" : modal?.type === "edit" ? "整理素材" : "删除素材";
  const blocked = modal?.type === "remove" && modal.references.some(reference => reference.blocksDelete);

  return (
    <div className="page-container">
      <header className="page-header">
        <div><h1>素材库</h1><p className="muted">集中整理并复用发布所需的图片与视频。</p></div>
        {canManage && <button className="button button-outline" onClick={() => open({ type: "folder" })}>
          <FolderPlus size={17} aria-hidden="true" />新建文件夹
        </button>}
      </header>

      {canManage && <section className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`} aria-label="上传素材"
        onDragEnter={event => { event.preventDefault(); dragCount.current++; setDragging(true); }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? "none" : "copy"; }}
        onDragLeave={event => { event.preventDefault(); if (--dragCount.current <= 0) { dragCount.current = 0; setDragging(false); } }}
        onDrop={event => { event.preventDefault(); dragCount.current = 0; setDragging(false); addFiles(event.dataTransfer.files); }}>
        <span className={styles.uploadIcon}><HardDriveUpload size={25} strokeWidth={1.6} aria-hidden="true" /></span>
        <div className={styles.uploadCopy}>
          <h2>{dragging ? "松开鼠标上传" : "拖拽素材到这里"}</h2>
          <p>JPG、PNG、GIF、MP4、MOV · 视频最大 2 GiB</p>
          <p>重新选择同一文件可续传。</p>
        </div>
        <input type="file" multiple accept={uploaderTypes} ref={picker} hidden
          onChange={event => { addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
        <button type="button" className="button button-primary" onClick={() => picker.current?.click()} disabled={busy}>
          选择文件
        </button>
      </section>}

      {transfers.length > 0 && <section className={styles.transferPanel} aria-label="上传进度">
        <header><h2>上传进度</h2>{transfers.some(row => row.state === "done") && <button type="button"
          className={styles.inlineAction} onClick={() => setTransfers(rows => rows.filter(row => row.state !== "done"))}>清除已完成</button>}</header>
        {transfers.map(row => <div key={row.id} className={styles.transfer}>
          <span className={styles.transferName} title={row.file.name}>{row.file.name}</span>
          <div><progress value={row.progress} max={100} aria-label={row.file.name + " 上传进度"} />
            {row.error && <p className={styles.transferError}>{row.error}</p>}</div>
          <span className={styles.transferState}>{transferLabel[row.state]}{row.state === "sending" ? ` ${row.progress}%` : ""}</span>
          {row.state === "sending" && <button className="icon-button" title="暂停上传" aria-label={"暂停上传 " + row.file.name}
            onClick={() => controllers.current.get(row.id)?.abort()}><Pause size={16} aria-hidden="true" /></button>}
          {["error", "paused"].includes(row.state) && <button className="icon-button" title="继续上传" aria-label={"继续上传 " + row.file.name}
            disabled={busy} onClick={() => void runBatch([row])}><RotateCcw size={16} aria-hidden="true" /></button>}
        </div>)}
      </section>}

      <section className={`panel ${styles.catalog}`} aria-label="素材列表">
        <form className={styles.filters} ref={filters} onSubmit={applyFilters}>
          <label className="field"><span>文件名</span><input type="search" name="q" placeholder="搜索素材名称" /></label>
          <label className="field"><span>文件夹</span><select name="folder" defaultValue="">
            <option value="">所有文件夹</option><option value="unfiled">未归档</option>
            {result.folders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
          </select></label>
          <label className="field"><span>标签</span><input name="tag" placeholder="输入完整标签" /></label>
          <label className="field"><span>上传人</span><select name="uploader" defaultValue="">
            <option value="">所有成员</option>{result.uploaders.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}
          </select></label>
          <label className="field"><span>起始日期</span><input name="from" type="date" /></label>
          <label className="field"><span>结束日期</span><input name="until" type="date" /></label>
          <div className={styles.filterActions}>
            <button className="button button-primary"><Search size={16} aria-hidden="true" />搜索</button>
            {query && <button className={styles.inlineAction} type="button" onClick={() => {
              filters.current?.reset(); setError(""); setQuery("");
            }}>清除筛选</button>}
          </div>
        </form>

        {error && <p className={styles.error} role="alert"><CircleAlert size={17} aria-hidden="true" />{error}</p>}
        <div className={styles.catalogToolbar}><h2>素材列表</h2><span aria-live="polite">{result.total} 项素材</span></div>

        {result.assets.length ? <div className={styles.tableWrap}><table>
          <thead><tr><th scope="col">名称</th><th scope="col">规格</th><th scope="col">文件夹 / 标签</th>
            <th scope="col">上传信息</th><th scope="col">操作</th></tr></thead>
          <tbody>{result.assets.map(asset => <tr key={asset.id}>
            <td><div className={styles.assetName}>
              <div className={styles.thumb}>{asset.status === "READY"
                ? <img src={`/api/assets/${asset.id}/thumbnail`} alt="" loading="lazy" />
                : asset.kind === "VIDEO" ? <Film size={24} aria-hidden="true" /> : <ImageIcon size={24} aria-hidden="true" />}</div>
              <div><strong title={asset.filename}>{asset.filename}</strong>
                {asset.status !== "READY" && <small className={asset.status === "FAILED" ? styles.transferError : ""}>
                  {asset.error ?? statusLabel[asset.status]}</small>}</div>
            </div></td>
            <td><div className={styles.meta}>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : displayBytes(asset.bytes)}
              <small>{asset.width && asset.height ? displayBytes(asset.bytes) : ""}
                {asset.duration !== null ? ` · ${displayDuration(asset.duration)}` : ""}</small></div></td>
            <td><div className={styles.meta}>{asset.folderName ?? "未归档"}
              <div className={styles.tags}>{asset.tags.map(tag => <span key={tag}>{tag}</span>)}</div></div></td>
            <td><div className={styles.meta}>{asset.uploaderName}<small>{displayDate.format(new Date(asset.createdAt))}</small></div></td>
            <td><div className={styles.itemActions}>
              {asset.status === "READY" && <a className="icon-button" href={`/api/assets/${asset.id}/file`}
                title="下载原件" aria-label={`下载 ${asset.filename}`}><ArrowDownToLine size={16} aria-hidden="true" /></a>}
              {asset.canEdit && <><button className="icon-button" onClick={() => open({ type: "edit", asset })}
                title="整理素材" aria-label={`整理 ${asset.filename}`}><Pencil size={16} aria-hidden="true" /></button>
                <button className="icon-button" onClick={() => void inspectRemoval(asset)}
                  title="删除素材" aria-label={`删除 ${asset.filename}`}><Trash2 size={16} aria-hidden="true" /></button></>}
            </div></td>
          </tr>)}</tbody>
        </table></div> : <div className={styles.empty}>
          <FileImage size={30} strokeWidth={1.4} aria-hidden="true" />
          <p>{query ? "未找到符合条件的素材" : "素材库还没有文件"}</p>
          {canManage && !query && <button type="button" className={styles.inlineAction}
            onClick={() => picker.current?.click()} disabled={busy}>上传第一份素材</button>}
        </div>}

        {(lastPage > 1 || result.page > 1) && <nav className={styles.pagination} aria-label="素材分页">
          <button className="icon-button" onClick={() => jump(result.page - 1)} disabled={result.page <= 1} aria-label="上一页">
            <ArrowLeft size={17} aria-hidden="true" /></button>
          <span>{result.page} / {lastPage}</span>
          <button className="icon-button" onClick={() => jump(result.page + 1)} disabled={result.page >= lastPage} aria-label="下一页">
            <ArrowRight size={17} aria-hidden="true" /></button>
        </nav>}
      </section>

      <dialog ref={dialog} className={styles.dialog} aria-labelledby="asset-dialog-title"
        onCancel={event => { event.preventDefault(); if (!saving) setModal(null); }}>
        {modal && <form onSubmit={save} className={styles.dialogBody} key={modal.type}>
          <header><h2 id="asset-dialog-title">{activeModalTitle}</h2>
            <button className="icon-button" type="button" onClick={() => setModal(null)} disabled={saving} aria-label="关闭">
              <X size={19} aria-hidden="true" /></button></header>
          {modal.type === "folder" && <label className="field"><span>文件夹名称</span><input name="name" maxLength={48} required /></label>}
          {modal.type === "edit" && <>
            <p className={styles.dialogFilename}>{modal.asset.filename}</p>
            <label className="field"><span>文件夹</span><select name="folder" defaultValue={modal.asset.folderId ?? ""}>
              <option value="">未归档</option>{result.folders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
            </select></label>
            <label className="field"><span>标签</span><textarea name="tags" defaultValue={modal.asset.tags.join("，")} maxLength={660} rows={2} />
              <small>用逗号分隔。最多 20 个，每个最多 32 字。</small></label>
          </>}
          {modal.type === "remove" && <>
            <p className={styles.dialogFilename}>{modal.asset.filename}</p>
            {modal.references.length > 0 ? <>
              <p>{blocked ? "草稿、审核中或仍可继续发布的任务正在使用此素材。请先处理这些内容。"
                : "确认后将删除素材原件和缩略图。发布记录和帖子链接仍可查看，使用此素材的历史素材包将无法下载。"}</p>
              <ul className={styles.references}>{modal.references.map(ref => {
                const detail = ref.status === "IN_REVIEW" || ref.status === "SUBMITTED" ? "/progress" : "";
                return <li key={ref.id}>
                  {ref.canOpen ? <Link className="text-link" href={`/contents/${ref.id}${detail}`}>{ref.title}</Link> : <span>{ref.title}</span>}
                  <span>{contentStatusLabel[ref.status]}{ref.blocksDelete ? " · 仍需保留" : ""}</span>
                </li>;
              })}</ul>
            </> : <p>该文件未被内容引用。确认后将删除素材及其原件。</p>}
          </>}
          {modalError && <p className={styles.error} role="alert">{modalError}</p>}
          <footer><button type="button" className="button button-outline" onClick={() => setModal(null)} disabled={saving}>
            {blocked ? "关闭" : "取消"}</button>
            {!blocked &&
              <button className={`button ${modal.type === "remove" ? styles.dangerButton : "button-primary"}`} disabled={saving}>
                {saving ? "处理中…" : modal.type === "remove" ? "确认删除" : "保存"}</button>}
          </footer>
        </form>}
      </dialog>
    </div>
  );
}
