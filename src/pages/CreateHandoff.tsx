import { useState } from "react";
import {
  CheckCircle2, FlaskConical, Info, ListFilter,
  CloudUpload, Lock, FileArchive, Loader, GitBranchPlus,
  Check, Minus, TriangleAlert, Package,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHead, Topbar } from "../components/Shell";
import { useProject } from "../state";
import { api, fmtTime, type CreateResult } from "../api";

const resultTone: Record<string, string> = { 通过: "green", 失败: "red", 超时: "", 未执行: "", 执行器错误: "red" };

export default function CreateHandoff() {
  const { active, refresh } = useProject();
  const [taskName, setTaskName] = useState("修复登录超时");
  const [claimText, setClaimText] = useState("");
  const [claimEvidence, setClaimEvidence] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [runChecks, setRunChecks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [pubBusy, setPubBusy] = useState<string | null>(null);
  const [pubMsg, setPubMsg] = useState<string | null>(null);

  const create = async () => {
    if (!active) return;
    setBusy(true); setErr(null); setResult(null); setPubMsg(null);
    try {
      const r = await api.createHandoff(active.projectId, {
        taskName: taskName.trim() || "未命名任务",
        claimText: claimText.trim() || undefined,
        claimEvidence: claimEvidence.trim() || undefined,
        nextStep: nextStep.trim() || undefined,
        runChecks,
      });
      setResult(r);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const publish = async (target: "github" | "local") => {
    if (!result) return;
    setPubBusy(target); setPubMsg(null);
    try {
      const { receipt } = await api.publish(result.record.handoffId, target);
      setPubMsg(`${receipt.state} → ${receipt.location}${receipt.commitSha ? ` @ ${receipt.commitSha.slice(0, 10)}` : ""}（读取确认 ${receipt.readBackConfirmed ? "✓" : "✗"}）`);
      setResult({ ...result, record: { ...result.record, publications: [...result.record.publications, receipt] } });
    } catch (e) { setPubMsg(`失败: ${e instanceof Error ? e.message : String(e)}`); }
    setPubBusy(null);
  };

  return (
    <>
      <Topbar path={[active?.name ?? "…", "创建交接"]} actions={
        <span className="pill amber"><span className="dot pulse" /> 捕获将读取当前工作区</span>
      } />
      <div className="content">
        <PageHead
          kicker="Create Handoff"
          title="创建交接 · 保存并上传"
          sub="捕获 → 检查 → 封装 → 封存。发布失败不会丢失已封存的交接，可幂等重试。"
        />

        {/* 向导步骤（状态即时呈现） */}
        <div className="steps">
          <div className="step done"><div className="no">STEP 01</div><div className="name">捕获快照</div><div className="desc">{result ? `快照 ${result.snapshot.id}` : "提交时执行"}</div></div>
          <div className={"step " + (result ? "done" : "")}><div className="no">STEP 02</div><div className="name">执行检查</div><div className="desc">{result ? `${result.verifications.filter((v) => v.result === "通过").length} 通过 · ${result.verifications.filter((v) => v.result !== "通过" && v.result !== "未执行").length} 失败` : runChecks ? "将执行已配置检查" : "跳过"}</div></div>
          <div className={"step " + (result ? "done" : busy ? "active" : "")}><div className="no">STEP 03</div><div className="name">{busy ? <><Loader size={15} className="amber spin" /> 封装</> : "封装"}</div><div className="desc">{result ? `清单校验通过 · ${result.record.manifest.entries.length} 项` : busy ? "进行中…" : "待提交"}</div></div>
          <div className="step"><div className="no">STEP 04</div><div className="name">发布</div><div className="desc">GitHub 或 本地文件</div></div>
        </div>

        <div className="grid g-12">
          {/* 表单 */}
          <section className="panel" style={{ gridColumn: "span 7" }}>
            <div className="corner" />
            <div className="panel-head"><FlaskConical size={15} className="amber" /><h3>任务与声明</h3><span className="tag">task / claims</span></div>
            <div className="panel-body">
              <Field label="任务名"><input className="acb-input" value={taskName} onChange={(e) => setTaskName(e.target.value)} /></Field>
              <Field label="Agent 声明（可选）"><textarea className="acb-input" rows={2} value={claimText} onChange={(e) => setClaimText(e.target.value)} placeholder="如：已将登录超时从 3s 调整为 8s 并加入重试" /></Field>
              <Field label="关联证据（可选）"><input className="acb-input" value={claimEvidence} onChange={(e) => setClaimEvidence(e.target.value)} placeholder="如：auth 套件 38 项通过" /></Field>
              <Field label="建议下一步（可选）"><input className="acb-input" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="如：修复 orders 套件失败后补跑 build" /></Field>
              <div className="check-row" style={{ cursor: "pointer" }} onClick={() => setRunChecks(!runChecks)}>
                <div className={"ck" + (runChecks ? " on" : "")}>{runChecks ? <Check size={12} /> : <Minus size={12} />}</div>
                <div><b className="small">执行已配置的检查（{active?.checks.length ?? 0} 条）</b><div className="xs faint mono">通过 / 失败 / 超时分别记录，失败不妨碍封存</div></div>
                <span className="badge">{runChecks ? "执行" : "跳过"}</span>
              </div>
              {err && <div className="notice warn" style={{ marginTop: 14 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}
              <button className="btn primary block" style={{ marginTop: 16 }} disabled={busy || !active} onClick={() => void create()}>
                {busy ? <Loader size={15} className="spin" /> : <GitBranchPlus size={15} />} 捕获并封存交接
              </button>
              {!active && <p className="xs faint" style={{ marginTop: 10 }}>请先在总览页注册/选择项目。</p>}
            </div>
          </section>

          {/* 纳入策略预览（真实数据） */}
          <section className="panel" style={{ gridColumn: "span 5" }}>
            <div className="panel-head"><ListFilter size={15} className="amber" /><h3>纳入策略 · 封存内容</h3><span className="tag">capture scope</span></div>
            <div className="panel-body" style={{ paddingTop: 6 }}>
              <div className="check-row"><div className="ck on"><Check size={12} /></div><div><b className="small">已暂存 + 未暂存改动（含删除/重命名）</b><div className="xs faint mono">分别保留暂存区与工作区恢复材料</div></div><span className="badge teal">纳入</span></div>
              <div className="check-row"><div className="ck on"><Check size={12} /></div><div><b className="small">未跟踪新文件</b><div className="xs faint mono">tests.ts 等未提交文件全部纳入</div></div><span className="badge teal">纳入</span></div>
              <div className="check-row"><div className="ck on"><Check size={12} /></div><div><b className="small">基线历史（git bundle）</b><div className="xs faint mono">接收端可重建 HEAD，无需原仓库</div></div><span className="badge teal">纳入</span></div>
              <div className="check-row"><div className="ck"><Minus size={12} /></div><div><b className="small">凭据与配置（.env*）</b><div className="xs faint mono">列入恢复要求，接收端需补齐</div></div><span className="badge red">排除</span></div>
              <div className="check-row"><div className="ck"><Minus size={12} /></div><div><b className="small">可重建产物（node_modules / dist / .acb）</b><div className="xs faint mono">依赖锁文件已纳入，产物不纳入</div></div><span className="badge red">排除</span></div>
            </div>
          </section>

          {/* 结果：检查 + 发布 */}
          {result && (
            <>
              <section className="panel" style={{ gridColumn: "span 7" }}>
                <div className="corner" />
                <div className="panel-head"><FlaskConical size={15} className="amber" /><h3>检查结果 · 绑定快照 <span className="mono xs">{result.snapshot.id}</span></h3><span className="tag">verification records</span></div>
                <div className="panel-body" style={{ paddingTop: 6 }}>
                  {result.verifications.length === 0 && <div className="xs muted" style={{ padding: "8px 0" }}>未执行检查（状态如实记录为未执行）。{result.warnings[0] ?? ""}</div>}
                  {result.verifications.map((v) => (
                    <div className="check-row" key={v.checkId}>
                      {v.result === "通过" ? <CheckCircle2 size={16} className="green" /> : v.result === "失败" ? <Info size={16} className="red" /> : <Info size={16} className="faint" />}
                      <div><b className="small">{v.name}</b><div className="xs faint mono">{v.result} · 退出码 {v.exitCode ?? "-"} · {v.durationMs}ms</div></div>
                      <span className={"badge " + resultTone[v.result]}>{v.result}</span>
                    </div>
                  ))}
                  <div className="notice info" style={{ marginTop: 14 }}>
                    <Info size={15} className="amber" />
                    <div className="xs muted">失败测试同样是有效的交接内容。<b className="amber">测试失败不妨碍封存与发布</b>；接手入口会如实呈现验证状态。</div>
                  </div>
                </div>
              </section>

              <section className="panel" style={{ gridColumn: "span 5" }}>
                <div className="corner" />
                <div className="panel-head"><CloudUpload size={15} className="amber" /><h3>发布目标</h3><span className="tag">transport</span></div>
                <div className="panel-body">
                  <div style={{ border: "1px solid color-mix(in srgb, var(--amber) 45%, transparent)", background: "var(--amber-dim)", padding: "13px 15px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <Lock size={16} className="amber" />
                      <b>GitHub · 交接分支</b>
                      <span className="badge green" style={{ marginLeft: "auto" }}>{active?.githubRemote ? "已配置" : "未配置"}</span>
                    </div>
                    <div className="mono xs muted" style={{ marginTop: 8 }}>{active?.githubRemote ?? "需在项目配置中填写 remote URL"} · 分支 <span className="amber">acb/handoff/{result.record.handoffId}</span></div>
                  </div>
                  <div style={{ border: "1px solid var(--line)", padding: "13px 15px", marginTop: 10, display: "flex", alignItems: "center", gap: 9 }}>
                    <FileArchive size={16} className="muted" />
                    <b className="muted">本地自包含文件</b>
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
                  {pubMsg && <div className="notice info" style={{ marginTop: 12 }}><div className="xs mono">{pubMsg}</div></div>}
                  <div className="notice info" style={{ marginTop: 12 }}>
                    <Package size={15} className="amber" />
                    <div className="xs muted">已封存 <Link className="mono amber" to={`/handoff/${result.record.handoffId}`}>{result.record.handoffId}</Link>（{fmtTime(result.record.sealedAt)}）。发布不改变源端分支、HEAD、暂存区与工作区；重复发布幂等。</div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="footer-note">
          <span>ACB / 02-CREATE</span>
          <span>检查绑定快照指纹</span>
          <span>发布状态与验证状态分别记录</span>
        </div>
      </div>
    </>
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
