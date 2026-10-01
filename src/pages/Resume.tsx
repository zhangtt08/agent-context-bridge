import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, Wrench, RefreshCw, OctagonX, Check, Loader, FileText, Info,
  MonitorCog, ListTree, Rocket, TriangleAlert, History, Laptop2, FolderOpen, Search,
  ShieldCheck, AlertOctagon,
} from "lucide-react";
import { PageHead, Panel, Topbar, DropArea } from "../components/Shell";
import { useProject } from "../state";
import { api, fmtTime, fmtBytes, waitJob, jobResult, type ResumeReport, type ResumePreview, type JobView, type ConflictPolicy } from "../api";

const verdictIcon = {
  可继续: <CheckCircle2 size={16} className="green" />,
  需要配置环境: <Wrench size={16} className="muted" />,
  需要重新验证: <RefreshCw size={16} className="muted" />,
  恢复被阻塞: <OctagonX size={16} className="muted" />,
};

/** 交接 ID 只用于显示与校验：包内自带 ID，恢复不再要求人手抄一遍 */
function idFromArchivePath(p: string): string {
  const m = /acb-(hnd_[a-z0-9]+)\.acb\.tar\.gz$/i.exec(p);
  return m ? m[1] : "";
}

export default function Resume() {
  const { active } = useProject();
  const [mode, setMode] = useState<"file" | "remote" | "github">("file");
  const [filePath, setFilePath] = useState("");
  const [handoffId, setHandoffId] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [remoteOverride, setRemoteOverride] = useState("");
  const [remoteList, setRemoteList] = useState<{ id: string; taskName: string | null }[] | null>(null);
  const [listing, setListing] = useState(false);
  const [reports, setReports] = useState<ResumeReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [preview, setPreview] = useState<ResumePreview | null>(null);
  const [githubPre, setGithubPre] = useState<{ reachable: boolean; detail: string } | null>(null);
  const [preBusy, setPreBusy] = useState(false);
  const [onConflict, setOnConflict] = useState<ConflictPolicy>("abort");
  const [job, setJob] = useState<JobView | null>(null);
  const [report, setReport] = useState<ResumeReport | null>(null);

  const loadReports = useCallback(async () => {
    try { setReports(await api.resumeReports()); } catch { /* 历史报告取不到不阻塞主流程 */ }
  }, []);
  useEffect(() => { void loadReports(); }, [loadReports]);

  const canPreview = mode === "file" ? !!filePath.trim() : mode === "github" ? !!handoffId.trim() && (!!remoteOverride.trim() || !!active?.githubRemote) : !!active && !!targetDir.trim();

  /** 还原前先预览：整包校验 + 目标目录比对，一个字节都不写 */
  const doPreview = async () => {
    setPreBusy(true); setErr(null); setPreview(null); setGithubPre(null);
    try {
      const r = await api.resumePreview({
        mode,
        filePath: mode === "file" ? filePath.trim() : undefined,
        handoffId: handoffId.trim() || undefined,
        projectId: active?.projectId,
        remote: mode === "github" && remoteOverride.trim() ? remoteOverride.trim() : undefined,
        targetDir: targetDir.trim(),
      });
      setPreview(r.preview ?? null);
      if (r.github) setGithubPre(r.github);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setPreBusy(false);
  };

  const run = async () => {
    setBusy(true); setErr(null); setReport(null); setJob(null);
    try {
      const r = await api.resume({
        mode,
        filePath: mode === "file" ? filePath.trim() : undefined,
        handoffId: handoffId.trim() || undefined,
        projectId: active?.projectId,
        remote: mode === "github" && remoteOverride.trim() ? remoteOverride.trim() : undefined,
        targetDir: targetDir.trim(),
        onConflict,
      });
      if (!("jobId" in r)) { setReport(r.report ?? null); }
      else {
        const view = await waitJob(r.jobId, setJob);
        if (view.state === "失败") throw new Error(`${view.error}${view.remedy ? ` 出路：${view.remedy}` : ""}`);
        setReport(jobResult<{ report: ResumeReport }>(view).report);
      }
      await loadReports();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const pickArchive = async () => {
    const f = await window.acb?.pickArchive?.();
    if (!f) return;
    setFilePath(f);
    const id = idFromArchivePath(f);
    if (id) setHandoffId(id);
  };

  const pickTarget = async () => {
    const dir = await window.acb?.pickFolder?.();
    if (dir) setTargetDir(dir);
  };

  // 拖入交接包 → 自动切换到文件模式并填路径 + 提取交接 ID
  const dropArchive = (p: string | null) => {
    if (!p) { setErr("桌面版才能通过拖放识别文件；请点「选择文件」或手动输入路径"); return; }
    if (!/\.acb\.tar\.gz$/i.test(p)) { setErr("拖入的应是 .acb.tar.gz 交接文件（在电脑 A 点「导出本地文件」得到）"); return; }
    setErr(null);
    setMode("file");
    setFilePath(p);
    const id = idFromArchivePath(p);
    if (id) setHandoffId(id);
  };

  const listRemote = async () => {
    setListing(true); setErr(null);
    try {
      const r = remoteOverride.trim() || active?.githubRemote || "";
      if (!r) throw new Error("请先填写远端地址，或在项目设置里配置 GitHub 远端");
      setRemoteList(await api.remoteHandoffs(active?.projectId ?? null, remoteOverride.trim() || undefined));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setRemoteList(null); }
    setListing(false);
  };

  const latest = report ?? reports[0];
  const blockers = (preview?.alerts ?? []).filter((a) => a.level === "阻塞");
  const needConflictChoice = !!preview && preview.conflicts.length > 0 && onConflict === "abort";
  const canRestore = !!targetDir.trim() && canPreview && !preBusy && !busy && blockers.length === 0 && !needConflictChoice && (!!preview || mode === "github");

  return (
    <>
      <Topbar path={[mode === "file" ? "交接文件" : mode === "github" ? "GitHub 交接分支" : "本机封存", "恢复交接"]} actions={
        <>
          <button className="btn sm ghost" disabled={!canPreview || preBusy} onClick={() => void doPreview()}>
            {preBusy ? <Loader size={13} className="spin" /> : <Search size={13} />} 预览差异
          </button>
          <span className="pill teal">{mode === "file" ? "来源：本地交接文件" : mode === "github" ? "来源：远端交接分支" : `来源：${active?.name ?? "项目"} 本机封存`}</span>
        </>
      } />
      <div className="content">
        <PageHead
          kicker="Resume & Receipt"
          title="还原交接 · 差异预览与校验回执"
          sub="先预览再落地：整包 SHA-256 逐条核对、目标目录撞车清单、还原后指纹与文件数回执。历史证据不会被视为本机已验证。"
        />

        {latest && (
          <div className="verdict">
            {(["可继续", "需要配置环境", "需要重新验证", "恢复被阻塞"] as const).map((v) => (
              <div className={"v" + (latest.verdict === v ? " sel" : "")} key={v}>
                <div className="t">{verdictIcon[v]} {v}</div>
                <div className="d">{latest.verdict === v ? `报告 ${latest.reportId} · ${fmtTime(latest.at)}` : v === "可继续" ? "代码指纹一致且必需材料齐备" : v === "恢复被阻塞" ? "未触发" : "见报告缺口清单"}</div>
              </div>
            ))}
          </div>
        )}

        <div className="grid g-12">
          <DropArea onPath={dropArchive} hint="松手，自动填入交接文件并提取 ID">
            <Panel title="① 来源与目标" icon={<Rocket size={15} className="amber" />} tag="source" corner style={{ gridColumn: "span 5" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button className={"btn sm " + (mode === "file" ? "primary" : "")} onClick={() => setMode("file")}>本地交接文件</button>
                <button className={"btn sm " + (mode === "remote" ? "primary" : "")} onClick={() => setMode("remote")} disabled={!active}>本机封存记录</button>
                <button className={"btn sm " + (mode === "github" ? "primary" : "")} onClick={() => setMode("github")}>GitHub 分支</button>
              </div>

              {mode === "file" && (
                <>
                  <div className="xs muted" style={{ marginBottom: 5 }}>交接文件路径（acb-*.acb.tar.gz，选中后自动提取交接 ID）</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="acb-input mono" style={{ flex: 1 }} value={filePath} onChange={(e) => {
                      setFilePath(e.target.value);
                      const id = idFromArchivePath(e.target.value);
                      if (id) setHandoffId(id);
                    }} placeholder="C:\Users\you\Downloads\acb-hnd_xxxx.acb.tar.gz" />
                    {window.acb?.pickArchive && <button className="btn" onClick={() => void pickArchive()}><FolderOpen size={14} /> 选择文件</button>}
                  </div>
                  <div className="xs muted" style={{ margin: "10px 0 5px" }}>交接 ID（可留空：以包内记录为准，填了会做一致性核对）</div>
                  <input className="acb-input mono" value={handoffId} onChange={(e) => setHandoffId(e.target.value)} placeholder="留空即可" />
                </>
              )}
              {mode === "remote" && (
                <>
                  <div className="xs muted" style={{ padding: "10px 12px", background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                    从 <b>{active?.name}</b> 的本机封存存储恢复（同一台电脑换目录 / 自检用）。留空恢复最新交接。跨电脑请用左边两个来源之一。
                  </div>
                  <div className="xs muted" style={{ margin: "10px 0 5px" }}>交接 ID（可选，留空取最新）</div>
                  <input className="acb-input mono" value={handoffId} onChange={(e) => setHandoffId(e.target.value)} placeholder="hnd_xxxxxxxx" />
                </>
              )}
              {mode === "github" && (
                <div className="xs muted" style={{ padding: "10px 12px", background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                  直接从 <b>{remoteOverride.trim() || active?.githubRemote || "项目配置的远端"}</b> 的交接分支恢复（真正的跨电脑路径：代码检查点 + 暂存材料 + 元数据都来自远端）。
                  <div style={{ marginTop: 8 }}><span className="muted">远端地址（留空用项目设置里配置的）：</span></div>
                  <input className="acb-input mono" style={{ marginTop: 6 }} value={remoteOverride} onChange={(e) => setRemoteOverride(e.target.value)} placeholder="https://github.com/you/repo.git 或本地裸仓路径" />
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                    <button className="btn sm ghost" disabled={listing} onClick={() => void listRemote()}>
                      {listing ? <Loader size={13} className="spin" /> : <Search size={13} />} 查看该仓库的交接
                    </button>
                    <span className="xs faint">不确定交接 ID？从远端选一个。</span>
                  </div>
                  {remoteList && (
                    <div style={{ marginTop: 10 }}>
                      {remoteList.length === 0 && <div className="xs muted">远端还没有任何交接（先在源电脑点「发布到 GitHub」）。</div>}
                      {remoteList.map((h) => (
                        <button key={h.id} className="li-row" style={{ width: "100%", textAlign: "left", cursor: "pointer", background: handoffId.trim() === h.id ? "var(--panel-3)" : "transparent", border: "1px solid var(--line)", padding: "8px 10px", marginBottom: 6 }}
                          onClick={() => setHandoffId(h.id)}>
                          <span className="mono xs amber">{h.id}</span>
                          <span className="xs" style={{ marginLeft: 10 }}>{h.taskName ?? "（无任务名）"}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="muted" style={{ marginTop: 8 }}>交接 ID：</div>
                  <input className="acb-input mono" style={{ marginTop: 6 }} value={handoffId} onChange={(e) => setHandoffId(e.target.value)} placeholder="hnd_xxxxxxxx" />
                </div>
              )}

              <div className="xs muted" style={{ margin: "10px 0 5px" }}>目标目录（必须是新目录或空目录）</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="acb-input mono" value={targetDir} onChange={(e) => setTargetDir(e.target.value)} placeholder="D:\dev\restored-project" />
                {window.acb?.pickFolder && <button className="btn" onClick={() => void pickTarget()}><FolderOpen size={14} /> 选目录</button>}
              </div>

              <div className="xs muted" style={{ margin: "12px 0 5px" }}>与目标目录撞车时</div>
              <div style={{ display: "flex", gap: 8 }}>
                {([["abort", "停止不覆盖"], ["skip", "跳过已存在"], ["overwrite", "用包内覆盖"]] as const).map(([v, label]) => (
                  <button key={v} className={"btn sm " + (onConflict === v ? "primary" : "ghost")} onClick={() => setOnConflict(v)}>{label}</button>
                ))}
              </div>
              <div className="xs faint" style={{ marginTop: 6 }}>默认「停止不覆盖」。选「覆盖」会用包内版本替换目标里不同的同名文件 —— 只在确认那批文件属于本次交接时使用。</div>

              {err && <div className="notice warn" style={{ marginTop: 12 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}
              <button className="btn primary block" style={{ marginTop: 14 }} disabled={!canRestore} onClick={() => void run()}>
                {busy ? <Loader size={15} className="spin" /> : <Rocket size={15} />}
                {busy ? "还原中…" : needConflictChoice ? "先处理撞车选项" : blockers.length ? `${blockers.length} 条阻塞，暂不还原` : preview ? "确认预览 → 还原" : "先点「预览差异」"}
              </button>
              {busy && job && (
                <div className="pbar" style={{ marginTop: 12 }}>
                  <div className="t"><Loader size={14} className="spin amber" /> {job.stage}<span className="no">{job.pct}%</span></div>
                  <div className="track"><i style={{ width: `${job.pct}%` }} /></div>
                  <div className="m">{job.message}</div>
                </div>
              )}
              <p className="xs faint" style={{ marginTop: 10 }}>把 .acb.tar.gz 拖到本页即可自动填路径；交接 ID 以包内记录为准，填错会被拒绝并说明。</p>
            </Panel>
          </DropArea>

          {/* ---------- ② 还原前差异预览 ---------- */}
          <Panel
            title="② 还原前预览" icon={<ShieldCheck size={15} className="amber" />}
            tag={preview ? `${preview.integrityOk ? "完整性通过" : "完整性异常"}` : "未预览"}
            style={{ gridColumn: "span 4" }}
          >
            {!preview && !preBusy && <div className="xs muted">还没有预览。填好来源与目标目录后点右上「预览差异」—— 这一步不写任何文件。</div>}
            {preBusy && <div className="xs muted"><Loader size={13} className="spin amber" /> 正在解包并逐条核对 SHA-256…</div>}
            {githubPre && (
              <div className={"notice " + (githubPre.reachable ? "info" : "warn")} style={{ marginBottom: 10 }}>
                {githubPre.reachable ? <CheckCircle2 size={15} className="green" /> : <AlertOctagon size={15} className="red" />}
                <div className="xs">{githubPre.detail}</div>
              </div>
            )}
            {preview && (
              <>
                <dl className="kv" style={{ gridTemplateColumns: "108px 1fr", marginBottom: 12 }}>
                  <dt>项目/任务</dt><dd>{preview.projectName} · {preview.taskName}</dd>
                  <dt>交接</dt><dd className="mono">{preview.handoffId}</dd>
                  <dt>封存于</dt><dd className="mono">{fmtTime(preview.sealedAt)}</dd>
                  <dt>协议</dt><dd className="mono">{preview.protocolVersion}</dd>
                  <dt>包完整性</dt><dd><span className={"badge " + (preview.integrityOk ? "green" : "red")}>{preview.verifiedCount}/{preview.entryCount} 条目 SHA-256 通过</span></dd>
                  <dt>将写入</dt><dd className="mono">{preview.willWrite} 文件 · {fmtBytes(preview.totalBytes)}{preview.willDelete ? ` · 保持删除 ${preview.willDelete}` : ""}</dd>
                  <dt>暂存材料</dt><dd className="mono">{preview.stagedCount} 项独立恢复</dd>
                  <dt>基线历史</dt><dd className="mono">{preview.baselineAvailable ? "bundle 可用" : "缺 bundle"}</dd>
                  {preview.symlinkCount > 0 && <><dt>符号链接</dt><dd className="mono">{preview.symlinkCount} 个待重建</dd></>}
                  <dt>源端环境</dt><dd className="mono">{preview.sourceEnv.os} / {preview.sourceEnv.runtime}</dd>
                  {preview.archiveInfo && <><dt>归档</dt><dd className="mono">{preview.archiveInfo}</dd></>}
                </dl>

                {preview.conflicts.length > 0 && (
                  <>
                    <div className="xs muted" style={{ marginBottom: 5 }}>目标目录撞车（{preview.conflicts.length} 项，其中 {preview.conflicts.filter((c) => !c.identical).length} 项内容不同）</div>
                    <div className="scope-list" style={{ maxHeight: 150 }}>
                      {preview.conflicts.map((c) => (
                        <div className="scope-row" key={c.path}>
                          <span className="p" title={c.path}>{c.path}</span>
                          <span className="b">{c.identical ? "内容相同" : `包 ${fmtBytes(c.packageBytes)} / 本机 ${fmtBytes(c.targetBytes)}`}</span>
                          <span className={"badge " + (c.identical ? "teal" : "red")}>{c.identical ? "可跳过" : "会被覆盖"}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {preview.alerts.map((a, i) => (
                  <div className={"alert " + (a.level === "阻塞" ? "block" : a.level === "警告" ? "warn" : "info")} key={i}>
                    <h6>{a.level === "提示" ? <Info size={14} className="teal" /> : <TriangleAlert size={14} className={a.level === "阻塞" ? "red" : "amber"} />}{a.title}
                      <span className={"badge " + (a.level === "阻塞" ? "red" : a.level === "警告" ? "amber" : "teal")} style={{ marginLeft: "auto" }}>{a.level}</span>
                    </h6>
                    <div className="d">{a.detail}</div>
                    <div className="a"><b>出路</b> {a.action}</div>
                  </div>
                ))}
              </>
            )}
          </Panel>

          {/* ---------- ③ 校验回执 ---------- */}
          <Panel title="③ 校验回执" icon={<MonitorCog size={15} className="amber" />} tag={latest ? latest.reportId : "无报告"} style={{ gridColumn: "span 3" }}>
            {!latest && <div className="xs muted">还原完成后，这里给出指纹与文件数回执，并在目标目录写入 ACB-HANDOFF.md 与 ACB-RESUME-REPORT.md。</div>}
            {latest && (
              <>
                {latest.entryCount !== undefined && (
                  <div className="li-row" style={{ padding: "9px 0" }}>
                    <span className={"badge " + (latest.digestMatch ? "green" : "red")}>{latest.digestMatch ? "指纹一致" : "指纹不一致"}</span>
                    <span className="xs muted">清单 {latest.entryCount} · 核对 {latest.verifiedCount ?? "—"} · 写入 {latest.restoredCount ?? "—"}</span>
                  </div>
                )}
                {latest.archiveSha256 && (
                  <div className="xs faint mono" style={{ wordBreak: "break-all", padding: "6px 0" }}>归档 sha256 {latest.archiveSha256.slice(0, 32)}…（与源端导出回执比对）</div>
                )}
                <div className="li-row" style={{ padding: "9px 0" }}>
                  {latest.entryMarkdownPath ? <FileText size={14} className="amber" /> : <Info size={14} className="faint" />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b className="small">接手入口</b>
                    <div className="xs faint mono" style={{ wordBreak: "break-all" }}>{latest.entryMarkdownPath ?? "未生成（本次还原被阻止）"}</div>
                  </div>
                </div>
                <div className="xs muted" style={{ marginTop: 8 }}>下一步：让接手的 Agent 直接读这份 ACB-HANDOFF.md，再在本机跑一次检查命令 —— 源端的通过记录不算本机结论。</div>
              </>
            )}
          </Panel>
        </div>

        {latest && (
          <Panel title="恢复流程回放" icon={<ListTree size={15} className="amber" />} tag={`resume · ${latest.steps.length} 步`} style={{ marginTop: 18 }}>
            <div className="resume-steps">
              {latest.steps.map((s, i) => (
                <div className={"rstep " + (s.ok ? "ok" : "cur")} key={i}>
                  <div className="ic">{s.ok ? <Check size={14} /> : <TriangleAlert size={14} className="red" />}</div>
                  <div><h5>{s.title}</h5><p>{s.detail}</p></div>
                </div>
              ))}
            </div>
            {latest.gaps.length > 0 && (
              <>
                <div className="xs muted" style={{ margin: "14px 0 6px" }}>差异与补齐动作</div>
                {latest.gaps.map((g, i) => (
                  <div className="li-row" key={i} style={{ padding: "9px 0", alignItems: "flex-start" }}>
                    {g.blocking ? <TriangleAlert size={14} className="red" /> : <History size={14} className="teal" />}
                    <div style={{ flex: 1 }}><b className="small">{g.title}</b><div className="xs muted">{g.detail}</div></div>
                    <span className={"badge " + (g.blocking ? "red" : "teal")}>{g.blocking ? "阻塞运行" : "提示"}</span>
                  </div>
                ))}
              </>
            )}
          </Panel>
        )}

        {reports.length > 1 && (
          <Panel title="还原历史" icon={<Laptop2 size={15} className="amber" />} tag={`${reports.length} 份报告`} style={{ marginTop: 18 }}>
            {reports.slice(0, 8).map((r) => (
              <div className="li-row" key={r.reportId} style={{ padding: "8px 0" }}>
                <span className="mono xs amber">{r.handoffId}</span>
                <span className="xs muted" style={{ marginLeft: 10 }}>{r.targetDir}</span>
                <span className="xs faint" style={{ marginLeft: "auto" }}>{fmtTime(r.at)}</span>
                <span className={"badge " + (r.verdict === "可继续" ? "green" : r.verdict === "恢复被阻塞" ? "red" : "amber")}>{r.verdict}</span>
              </div>
            ))}
          </Panel>
        )}

        <div className="footer-note">
          <span>ACB / 04-RESUME</span>
          <span>预览不写盘 · 还原给回执</span>
          <span>历史证据 ≠ 本机已验证</span>
        </div>
      </div>
    </>
  );
}
