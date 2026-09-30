import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, Wrench, RefreshCw, OctagonX, Check, Loader, FileText,
  MonitorCog, ListTree, Rocket, TriangleAlert, History, Laptop2,
} from "lucide-react";
import { PageHead, Panel, Topbar } from "../components/Shell";
import { useProject } from "../state";
import { api, fmtTime, type ResumeReport } from "../api";

const verdictIcon = {
  可继续: <CheckCircle2 size={16} className="green" />,
  需要配置环境: <Wrench size={16} className="muted" />,
  需要重新验证: <RefreshCw size={16} className="muted" />,
  恢复被阻塞: <OctagonX size={16} className="muted" />,
};

export default function Resume() {
  const { active } = useProject();
  const [mode, setMode] = useState<"file" | "remote" | "github">("file");
  const [filePath, setFilePath] = useState("");
  const [handoffId, setHandoffId] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [remoteOverride, setRemoteOverride] = useState("");
  const [reports, setReports] = useState<ResumeReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    try { setReports(await api.resumeReports()); } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { void loadReports(); }, [loadReports]);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      await api.resume({
        mode,
        filePath: mode === "file" ? filePath.trim() : undefined,
        handoffId: handoffId.trim().replace(/^acb-/, "").replace(/\.acb\.tar\.gz$/, "") || undefined,
        projectId: active?.projectId,
        remote: mode === "github" && remoteOverride.trim() ? remoteOverride.trim() : undefined,
        targetDir: targetDir.trim(),
      });
      await loadReports();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const latest = reports[0];

  return (
    <>
      <Topbar path={["电脑 · 新环境", "恢复交接"]} actions={
        <span className="pill teal">{mode === "file" ? "来源：本地交接文件" : `来源：${active?.name ?? "项目"} 本机封存`}</span>
      } />
      <div className="content">
        <PageHead
          kicker="Resume & Report"
          title="恢复交接 · 接手报告"
          sub="先校验再展开；历史证据保留“未在本机验证”状态，本机差异不会表述为已验证通过。"
        />

        {/* 最新报告四态 */}
        {latest && (
          <div className="verdict">
            {(["可继续", "需要配置环境", "需要重新验证", "恢复被阻塞"] as const).map((v) => (
              <div className={"v" + (latest.verdict === v ? " sel" : "")} key={v}>
                <div className="t">{verdictIcon[v]} {v}</div>
                <div className="d">{latest.verdict === v ? `报告 ${latest.reportId} · ${fmtTime(latest.at)}` : v === "可继续" ? "代码指纹比对一致，必需材料齐备" : v === "恢复被阻塞" ? "未触发" : "见报告缺口清单"}</div>
              </div>
            ))}
          </div>
        )}

        <div className="grid g-12">
          <Panel title="发起恢复" icon={<Rocket size={15} className="amber" />} tag="resume" corner style={{ gridColumn: "span 5" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <button className={"btn sm " + (mode === "file" ? "primary" : "")} onClick={() => setMode("file")}>本地交接文件</button>
              <button className={"btn sm " + (mode === "remote" ? "primary" : "")} onClick={() => setMode("remote")} disabled={!active}>本机封存记录</button>
              <button className={"btn sm " + (mode === "github" ? "primary" : "")} onClick={() => setMode("github")}>GitHub 交接分支</button>
            </div>
            {mode === "file" && (
              <>
                <div className="xs muted" style={{ marginBottom: 5 }}>交接文件路径（acb-*.acb.tar.gz）</div>
                <input className="acb-input mono" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="C:\Users\you\Downloads\acb-hnd_xxxx.acb.tar.gz" />
                <div className="xs muted" style={{ margin: "10px 0 5px" }}>交接 ID</div>
                <input className="acb-input mono" value={handoffId} onChange={(e) => setHandoffId(e.target.value)} placeholder="hnd_xxxxxxxx" />
              </>
            )}
            {mode === "remote" && (
              <>
                <div className="xs muted" style={{ padding: "10px 12px", background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                  从 <b>{active?.name}</b> 的本机封存存储恢复（模拟“同一台电脑的另一个目录”场景）。留空恢复最新交接，也可在下方指定。
                </div>
                <div className="xs muted" style={{ margin: "10px 0 5px" }}>交接 ID（可选，留空取最新）</div>
                <input className="acb-input mono" value={handoffId} onChange={(e) => setHandoffId(e.target.value)} placeholder="hnd_xxxxxxxx" />
              </>
            )}
            {mode === "github" && (
              <div className="xs muted" style={{ padding: "10px 12px", background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                直接从 <b>{active?.githubRemote ?? "项目配置的远端"}</b> 的交接分支 <span className="mono">acb/handoff/&lt;id&gt;</span> 恢复（真正的跨电脑路径：代码检查点 + 暂存材料 + 元数据都来自远端）。
                <div style={{ marginTop: 8 }}><span className="muted">交接 ID：</span></div>
                <input className="acb-input mono" style={{ marginTop: 6 }} value={handoffId} onChange={(e) => setHandoffId(e.target.value)} placeholder="hnd_xxxxxxxx" />
                <div className="muted" style={{ marginTop: 8 }}>远端覆盖（可选，留空用项目配置）：</div>
                <input className="acb-input mono" style={{ marginTop: 6 }} value={remoteOverride} onChange={(e) => setRemoteOverride(e.target.value)} placeholder="https://github.com/you/repo.git 或本地裸仓路径" />
              </div>
            )}
            <div className="xs muted" style={{ margin: "10px 0 5px" }}>目标目录（默认使用新的隔离目录）</div>
            <input className="acb-input mono" value={targetDir} onChange={(e) => setTargetDir(e.target.value)} placeholder="D:\dev\restored-project" />
            {err && <div className="notice warn" style={{ marginTop: 12 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}
            <button className="btn primary block" style={{ marginTop: 14 }} disabled={busy || !targetDir.trim() || (mode === "file" ? !filePath.trim() : mode === "github" ? !handoffId.trim() : !active)} onClick={() => void run()}>
              {busy ? <Loader size={15} className="spin" /> : <Rocket size={15} />} 校验并恢复
            </button>
            <p className="xs faint" style={{ marginTop: 10 }}>恢复先校验后展开；目标目录非空时会被阻止（不覆盖已有工作）。</p>
          </Panel>

          <Panel title="最新报告" icon={<MonitorCog size={15} className="amber" />} tag={latest ? latest.reportId : "无报告"} style={{ gridColumn: "span 4" }}>
            {!latest && <div className="xs muted">尚无恢复报告。发起一次恢复后，Resume Report 会在此呈现。</div>}
            {latest && (
              <>
                {latest.steps.map((s, i) => (
                  <div className="li-row" key={i} style={{ padding: "9px 0", alignItems: "flex-start" }}>
                    {s.ok ? <Check size={15} className="green" /> : <TriangleAlert size={15} className="red" />}
                    <div style={{ flex: 1 }}>
                      <b className="small">{s.title}</b>
                      <div className="xs muted">{s.detail}</div>
                    </div>
                  </div>
                ))}
                {latest.gaps.length > 0 && (
                  <>
                    <div className="xs muted" style={{ margin: "10px 0 4px" }}>差异与补齐动作</div>
                    {latest.gaps.map((g, i) => (
                      <div className="li-row" key={i} style={{ padding: "9px 0", alignItems: "flex-start" }}>
                        {g.blocking ? <TriangleAlert size={14} className="red" /> : <History size={14} className="teal" />}
                        <div style={{ flex: 1 }}><b className="small">{g.title}</b><div className="xs muted">{g.detail}</div></div>
                        <span className={"badge " + (g.blocking ? "red" : "teal")}>{g.blocking ? "阻塞运行" : "提示"}</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </Panel>

          <Panel title="接手入口" icon={<FileText size={15} className="amber" />} tag="markdown" style={{ gridColumn: "span 3" }}>
            {latest?.entryMarkdownPath ? (
              <>
                <div className="xs muted" style={{ marginBottom: 10 }}>已写入目标目录，接手 Agent 可直接阅读：</div>
                <div className="mono xs" style={{ background: "var(--panel-2)", border: "1px solid var(--line)", padding: "10px 12px", wordBreak: "break-all" }}>{latest.entryMarkdownPath}</div>
                <button className="btn primary sm block" style={{ marginTop: 12 }} onClick={() => { void navigator.clipboard.writeText(latest.entryMarkdownPath ?? ""); }}>
                  复制路径
                </button>
                {reports.length > 1 && (
                  <div style={{ marginTop: 16 }}>
                    <div className="xs muted" style={{ marginBottom: 6 }}>历史报告（{reports.length}）</div>
                    {reports.slice(0, 5).map((r) => (
                      <div key={r.reportId} className="li-row" style={{ padding: "7px 0" }}>
                        <Laptop2 size={13} className="faint" />
                        <span className="mono xs">{r.handoffId}</span>
                        <span className={"badge " + (r.verdict === "可继续" ? "green" : r.verdict === "恢复被阻塞" ? "red" : "amber")} style={{ marginLeft: "auto" }}>{r.verdict}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="xs muted">恢复成功后，ACB-HANDOFF.md 与恢复报告将生成到目标目录，并在此提供入口。</div>
            )}
          </Panel>
        </div>

        {latest && (
          <Panel title="恢复流程回放" icon={<ListTree size={15} className="amber" />} tag={`resume · ${latest.steps.length} 步`} style={{ marginTop: 18 }}>
            <div className="resume-steps">
              {latest.steps.map((s, i) => (
                <div className={"rstep " + (s.ok ? "ok" : "cur")} key={i}>
                  <div className="ic">{s.ok ? <Check size={14} /> : <Loader size={14} />}</div>
                  <div><h5>{s.title}</h5><p>{s.detail}</p></div>
                </div>
              ))}
            </div>
          </Panel>
        )}

        <div className="footer-note">
          <span>ACB / 04-RESUME</span>
          <span>恢复先校验再展开</span>
          <span>历史证据 ≠ 本机已验证</span>
        </div>
      </div>
    </>
  );
}
