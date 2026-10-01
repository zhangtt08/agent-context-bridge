import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, FlaskConical, Info, ListFilter, CloudUpload, Lock, FileArchive, Loader,
  GitBranchPlus, Check, Minus, TriangleAlert, Package, Search, RefreshCw, ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHead, Topbar, Panel } from "../components/Shell";
import { useProject } from "../state";
import {
  api, fmtTime, fmtBytes, waitJob, jobResult,
  type CapturePreview, type CreateResult, type JobView, type PreviewAlert,
} from "../api";

const resultTone: Record<string, string> = { 通过: "green", 失败: "red", 超时: "", 未执行: "", 执行器错误: "red" };

export default function CreateHandoff() {
  const { active, refresh } = useProject();
  const [taskName, setTaskName] = useState("");
  const [claimText, setClaimText] = useState("");
  const [claimEvidence, setClaimEvidence] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [runChecks, setRunChecks] = useState(true);
  const [ackWarn, setAckWarn] = useState(false);

  const [preview, setPreview] = useState<CapturePreview | null>(null);
  const [prevBusy, setPrevBusy] = useState(false);
  const [prevErr, setPrevErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"in" | "out">("in");

  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [pubBusy, setPubBusy] = useState<string | null>(null);
  const [pubMsg, setPubMsg] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    if (!active) { setPreview(null); return; }
    setPrevBusy(true); setPrevErr(null);
    try { setPreview(await api.preview(active.projectId)); }
    catch (e) { setPreview(null); setPrevErr(e instanceof Error ? e.message : String(e)); }
    setPrevBusy(false);
  }, [active]);

  useEffect(() => { setResult(null); setJob(null); setAckWarn(false); void loadPreview(); }, [loadPreview]);

  const blockers = (preview?.alerts ?? []).filter((a) => a.level === "阻塞");
  const warnings = (preview?.alerts ?? []).filter((a) => a.level === "警告");
  const needsAck = warnings.length > 0 && !ackWarn;
  const canPack = !!preview && !prevBusy && !busy && blockers.length === 0 && !needsAck && !!active;

  const pack = async () => {
    if (!active) return;
    setBusy(true); setErr(null); setResult(null); setPubMsg(null);
    try {
      const { jobId } = await api.createHandoff(active.projectId, {
        taskName: taskName.trim() || "未命名任务",
        claimText: claimText.trim() || undefined,
        claimEvidence: claimEvidence.trim() || undefined,
        nextStep: nextStep.trim() || undefined,
        runChecks,
      });
      const view = await waitJob(jobId, setJob);
      if (view.state === "失败") throw new Error(`${view.error}${view.remedy ? `
出路：${view.remedy}` : ""}`);
      setResult(jobResult<CreateResult>(view));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const publish = async (target: "github" | "local") => {
    if (!result) return;
    setPubBusy(target); setPubMsg(null);
    try {
      const { receipt } = await api.publish(result.record.handoffId, target);
      setPubMsg(`${receipt.state} → ${receipt.location}${receipt.commitSha ? ` @ ${receipt.commitSha.slice(0, 10)}` : ""}（读取确认 ${receipt.readBackConfirmed ? "✓" : "✗"}）${receipt.archiveSha256 ? `
归档 SHA-256：${receipt.archiveSha256} · ${fmtBytes(receipt.archiveBytes ?? 0)}` : ""}${receipt.error ? `
${receipt.error}` : ""}`);
      setResult({ ...result, record: { ...result.record, publications: [...result.record.publications, receipt] } });
    } catch (e) { setPubMsg(`失败: ${e instanceof Error ? e.message : String(e)}`); }
    setPubBusy(null);
  };

  const step = result ? 3 : job || busy ? 2 : 1;

  return (
    <>
      <Topbar path={[active?.name ?? "…", "创建交接"]} actions={
        <>
          <button className="btn sm ghost" disabled={prevBusy || busy} onClick={() => void loadPreview()}>
            {prevBusy ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />} 重新审阅
          </button>
          <span className="pill amber"><span className="dot pulse" /> 清单来自当前工作区实况</span>
        </>
      } />
      <div className="content">
        <PageHead
          kicker="Create Handoff"
          title="创建交接 · 审阅 → 打包 → 交接"
          sub="先看清带什么、不带什么、为什么；打包有进度；发布给回执。发布失败不丢已封存的交接，可幂等重试。"
        />

        <div className="steps">
          <div className={"step " + (step > 1 ? "done" : "active")}>
            <div className="no">STEP 01</div>
            <div className="name">审阅清单</div>
            <div className="desc">{preview ? `${preview.included.length} 项纳入 · ${preview.excluded.length} 项排除 · ${preview.alerts.length} 条提示` : prevBusy ? "正在扫描工作区…" : "等待扫描"}</div>
          </div>
          <div className={"step " + (result ? "done" : step === 2 ? "active" : "")}>
            <div className="no">STEP 02</div>
            <div className="name">{busy ? <><Loader size={15} className="spin" /> 打包封存</> : "打包封存"}</div>
            <div className="desc">{result ? `快照 ${result.snapshot.id} · ${fmtBytes(result.snapshot.bytes)}` : job ? job.message : busy ? "进行中…" : "审阅通过后开始"}</div>
          </div>
          <div className={"step " + (result ? (result.record.publications.some((p) => p.state === "已发布") ? "done" : "active") : "")}>
            <div className="no">STEP 03</div>
            <div className="name">交接</div>
            <div className="desc">{result ? `已封存 ${result.record.handoffId} · 待发布` : "GitHub 交接分支 或 本地交接文件"}</div>
          </div>
        </div>

        {prevErr && (
          <div className="notice warn" style={{ marginBottom: 16 }}>
            <TriangleAlert size={15} className="red" />
            <div className="xs red">审阅清单取不到：{prevErr} — 修好后点右上「重新审阅」，不要绕过这一步直接打包。</div>
          </div>
        )}

        <div className="grid g-12">
          {/* ---------- STEP 1：审阅清单 ---------- */}
          <Panel
            title="纳入范围 · 逐项审阅" icon={<ListFilter size={15} className="amber" />}
            tag={preview ? `${fmtBytes(preview.includedBytes)} 改动内容` : "capture scope"}
            style={{ gridColumn: "span 7" }}
            headExtra={preview ? <span className="badge">{preview.baseline.branch ?? "(无分支)"} @ {preview.baseline.commit?.slice(0, 7) ?? "无"}</span> : undefined}
          >
            {!preview && !prevBusy && <div className="xs muted">还没有清单。注册项目后会自动扫描；也可点右上「重新审阅」。</div>}
            {prevBusy && <div className="xs muted"><Loader size={13} className="spin amber" /> 正在探测工作区形态（不读文件内容，通常几秒内完成）…</div>}

            {preview && (
              <>
                <div className="seg">
                  <button className={"btn sm " + (tab === "in" ? "primary" : "ghost")} onClick={() => setTab("in")}>纳入 {preview.included.length}</button>
                  <button className={"btn sm " + (tab === "out" ? "primary" : "ghost")} onClick={() => setTab("out")}>排除 {preview.excluded.length}</button>
                </div>

                {tab === "in" && (
                  <div className="scope-list">
                    {preview.included.length === 0 && <div className="xs muted" style={{ padding: 12 }}>工作区没有未提交改动 —— 本次只会封存基线提交。</div>}
                    {preview.included.map((f) => (
                      <div className="scope-row" key={f.path}>
                        <span className="p" title={f.path}>{f.path}</span>
                        <span className="b">{f.status}{f.staged ? "+暂存" : ""}{f.kind === "symlink" ? " · 链接" : f.kind === "executable" ? " · 可执行" : ""}</span>
                        <span className="b">{f.status === "deleted" ? "删除" : fmtBytes(f.bytes)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {tab === "out" && (
                  <>
                    <div className="scope-list">
                      {preview.excluded.length === 0 && <div className="xs muted" style={{ padding: 12 }}>没有排除项 —— 工作区里未提交的改动全部会进包。</div>}
                      {preview.excluded.map((e) => (
                        <div className="scope-row" key={e.path} style={{ gridTemplateColumns: "1fr auto" }}>
                          <div style={{ minWidth: 0 }}>
                            <div className="p" title={e.path}>{e.path}</div>
                            <div className="why">{e.reason}</div>
                          </div>
                          <span className={"badge " + (e.kind === "凭据" ? "red" : "")}>{e.kind}</span>
                        </div>
                      ))}
                    </div>
                    <div className="xs faint" style={{ marginTop: 8 }}>
                      排除规则：{preview.excluded.length ? [...new Set(preview.excluded.map((e) => e.kind))].join(" / ") : "—"}。另外，被 .gitignore 忽略的文件不会出现在 git status 里，因此也不会进入交接包。
                    </div>
                  </>
                )}

                <div className="xs faint" style={{ marginTop: 10 }}>{preview.bundleNote}</div>
              </>
            )}
          </Panel>

          {/* ---------- 告警与出路 ---------- */}
          <Panel
            title="审阅结论" icon={<ShieldCheck size={15} className="amber" />}
            tag={preview ? `${preview.alerts.length} 条` : "待扫描"} corner
            style={{ gridColumn: "span 5" }}
          >
            {preview && preview.alerts.length === 0 && (
              <div className="xs muted">没有发现需要处理的问题：路径安全、无大小写碰撞、无历史凭据残留。可以直接打包。</div>
            )}
            {!preview && <div className="xs muted">清单出来后才能给结论。若一直转圈，看上方错误提示。</div>}
            {preview?.alerts.map((a, i) => <AlertCard key={i} a={a} />)}

            {preview && warnings.length > 0 && (
              <div className="check-row" style={{ cursor: "pointer", marginTop: 10 }} onClick={() => setAckWarn(!ackWarn)}>
                <div className={"ck" + (ackWarn ? " on" : "")}>{ackWarn ? <Check size={12} /> : <Minus size={12} />}</div>
                <div>
                  <b className="small">我已确认上面 {warnings.length} 条警告</b>
                  <div className="xs faint">历史里的凭据无法由打包环节排除，确认由你承担</div>
                </div>
                <span className="badge">{ackWarn ? "已确认" : "待确认"}</span>
              </div>
            )}

            <div className="xs muted" style={{ marginTop: 12 }}>
              纳入策略：改动内容（含暂存/未暂存/新文件/删除/重命名）+ 基线历史 bundle + 检查证据。
            </div>
            <div className="li-row" style={{ padding: "9px 0" }}>
              <span className="badge teal">检查命令 {preview?.checksConfigured ?? active?.checks.length ?? 0} 条</span>
              <Link to="/settings" className="btn sm ghost" style={{ marginLeft: "auto" }}>去配置</Link>
            </div>
          </Panel>

          {/* ---------- 任务信息 + 打包 ---------- */}
          <Panel title="任务与声明" icon={<FlaskConical size={15} className="amber" />} tag="写进接手入口" style={{ gridColumn: "span 7" }}>
            <Field label="任务名"><input className="acb-input" value={taskName} onChange={(e) => setTaskName(e.target.value)} placeholder="另一台电脑上的 Agent 要接着做的那件事，如：把登录超时从 3s 调到 8s 并补重试" /></Field>
            <Field label="Agent 声明（可选）"><textarea className="acb-input" rows={2} value={claimText} onChange={(e) => setClaimText(e.target.value)} placeholder="如：已将登录超时从 3s 调整为 8s 并加入重试" /></Field>
            <Field label="关联证据（可选）"><input className="acb-input" value={claimEvidence} onChange={(e) => setClaimEvidence(e.target.value)} placeholder="如：auth 套件 38 项通过" /></Field>
            <Field label="建议下一步（可选）"><input className="acb-input" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="如：修复 orders 套件失败后补跑 build" /></Field>
            <div className="check-row" style={{ cursor: "pointer" }} onClick={() => setRunChecks(!runChecks)}>
              <div className={"ck" + (runChecks ? " on" : "")}>{runChecks ? <Check size={12} /> : <Minus size={12} />}</div>
              <div><b className="small">执行已配置的检查（{active?.checks.length ?? 0} 条）</b><div className="xs faint mono">通过 / 失败 / 超时分别记录，失败不妨碍封存</div></div>
              <span className="badge">{runChecks ? "执行" : "跳过"}</span>
            </div>

            {err && <div className="notice warn" style={{ marginTop: 14 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}

            {busy && job && (
              <div className="pbar" style={{ marginTop: 14 }}>
                <div className="t"><Loader size={14} className="spin amber" /> {job.stage}<span className="no">{job.pct}%</span></div>
                <div className="track"><i style={{ width: `${job.pct}%` }} /></div>
                <div className="m">{job.message}</div>
              </div>
            )}

            <button className="btn primary block" style={{ marginTop: 16 }} disabled={!canPack} onClick={() => void pack()}>
              {busy ? <Loader size={15} className="spin" /> : <GitBranchPlus size={15} />}
              {busy ? "打包中…" : blockers.length ? "阻塞项未处理，无法打包" : preview ? "审阅通过 → 打包封存" : "等待审阅"}
            </button>
            {!active && <p className="xs faint" style={{ marginTop: 10 }}>请先在总览页注册/选择项目。</p>}
            {blockers.length > 0 && (
              <p className="xs red" style={{ marginTop: 10 }}>
                有 {blockers.length} 条阻塞项（见右上「审阅结论」）。ACB 不会替你改项目文件 —— 按每条给出的出路处理后再打包。
              </p>
            )}
          </Panel>

          {/* ---------- 检查结果 + 发布 ---------- */}
          {result && (
            <>
              <Panel title="检查结果" icon={<FlaskConical size={15} className="green" />} tag={`绑定快照 ${result.snapshot.id}`} style={{ gridColumn: "span 7" }}>
                {result.verifications.length === 0 && <div className="xs muted" style={{ padding: "8px 0" }}>未执行检查（状态如实记录为未执行）。{result.warnings[0] ?? ""}</div>}
                {result.verifications.map((v) => (
                  <div className="check-row" key={v.checkId}>
                    {v.result === "通过" ? <CheckCircle2 size={16} className="green" /> : <Info size={16} className={v.result === "失败" || v.result === "执行器错误" ? "red" : "faint"} />}
                    <div><b className="small">{v.name}</b><div className="xs faint mono">{v.result} · 退出码 {v.exitCode ?? "-"} · {v.durationMs}ms</div></div>
                    <span className={"badge " + resultTone[v.result]}>{v.result}</span>
                  </div>
                ))}
                {result.warnings.map((w, i) => <div className="notice info" key={i} style={{ marginTop: 12 }}><Info size={15} className="amber" /><div className="xs muted">{w}</div></div>)}
                <div className="notice info" style={{ marginTop: 14 }}>
                  <Info size={15} className="amber" />
                  <div className="xs muted">失败测试同样是有效的交接内容。<b className="amber">测试失败不妨碍封存与发布</b>；接手入口会如实呈现验证状态，接收端不会把源端结论当本机结论。</div>
                </div>
              </Panel>

              <Panel title="交接 · 发布回执" icon={<CloudUpload size={15} className="amber" />} tag="transport" corner style={{ gridColumn: "span 5" }}>
                <div style={{ border: "1px solid color-mix(in srgb, var(--amber) 45%, transparent)", background: "var(--amber-dim)", padding: "13px 15px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <Lock size={16} className="amber" /><b>GitHub · 交接分支</b>
                    <span className="badge green" style={{ marginLeft: "auto" }}>{active?.githubRemote ? "已配置" : "未配置"}</span>
                  </div>
                  <div className="mono xs muted" style={{ marginTop: 8 }}>{active?.githubRemote ?? "需在项目设置中填写 remote URL"} · 分支 <span className="amber">acb/handoff/{result.record.handoffId}</span></div>
                </div>
                <div style={{ border: "1px solid var(--line)", padding: "13px 15px", marginTop: 10, display: "flex", alignItems: "center", gap: 9 }}>
                  <FileArchive size={16} className="muted" /><b className="muted">本地自包含文件</b>
                  <span className="xs faint" style={{ marginLeft: "auto" }}>下载目录 · acb-{result.record.handoffId}.acb.tar.gz</span>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                  <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} disabled={pubBusy !== null} onClick={() => void publish("local")}>
                    {pubBusy === "local" ? <Loader size={14} className="spin" /> : <FileArchive size={14} />} 导出本地文件
                  </button>
                  <button className="btn" style={{ flex: 1, justifyContent: "center" }} disabled={pubBusy !== null || !active?.githubRemote} onClick={() => void publish("github")}>
                    {pubBusy === "github" ? <Loader size={14} className="spin" /> : <CloudUpload size={14} />} 发布到 GitHub
                  </button>
                </div>
                {pubMsg && (
                  <div className="notice info" style={{ marginTop: 12 }}>
                    <div className="xs mono" style={{ whiteSpace: "pre-wrap" }}>{pubMsg}</div>
                    {result.record.publications.some((p) => p.target === "local" && p.state === "已发布") && (
                      <Link to="/resume" className="btn sm primary" style={{ marginTop: 9 }}><Search size={13} /> 下一步：另一台电脑上还原</Link>
                    )}
                  </div>
                )}
                <div className="notice info" style={{ marginTop: 12 }}>
                  <Package size={15} className="amber" />
                  <div className="xs muted">已封存 <Link className="mono amber" to={`/handoff/${result.record.handoffId}`}>{result.record.handoffId}</Link>（{fmtTime(result.record.sealedAt)}）· {result.record.manifest.entries.length} 个包内条目。发布不改变源端分支、HEAD、暂存区与工作区；重复发布幂等。</div>
                </div>
              </Panel>
            </>
          )}
        </div>

        <div className="footer-note">
          <span>ACB / 02-CREATE</span>
          <span>清单先审 · 打包有进度 · 发布给回执</span>
          <span>封存内容不可原地更新</span>
        </div>
      </div>
    </>
  );
}

function AlertCard({ a }: { a: PreviewAlert }) {
  const tone = a.level === "阻塞" ? "block" : a.level === "警告" ? "warn" : "info";
  return (
    <div className={"alert " + tone}>
      <h6>
        {a.level === "提示" ? <Info size={14} className="teal" /> : <TriangleAlert size={14} className={a.level === "阻塞" ? "red" : "amber"} />}
        {a.title}
        <span className={"badge " + (a.level === "阻塞" ? "red" : a.level === "警告" ? "amber" : "teal")} style={{ marginLeft: "auto" }}>{a.level}</span>
      </h6>
      <div className="d">{a.detail}</div>
      <div className="a"><b>出路</b> {a.action}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="xs muted" style={{ marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}
