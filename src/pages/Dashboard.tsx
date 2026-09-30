import { useCallback, useEffect, useState } from "react";
import {
  GitBranchPlus, GitCommitVertical, GitFork, Package, MonitorCog, TriangleAlert,
  ChevronRight, Loader, RefreshCw, Plus, FolderGit2, FlaskConical,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHead, Panel, Topbar } from "../components/Shell";
import { useProject } from "../state";
import { api, fmtTime, type Overview } from "../api";

export default function Dashboard() {
  const { active, projects, setActiveId, refresh } = useProject();
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [regPath, setRegPath] = useState("");

  const load = useCallback(async () => {
    if (!active) { setOv(null); return; }
    try { setOv(await api.overview(active.projectId)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [active]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const register = async (seed: boolean) => {
    setBusy("register");
    try {
      if (seed) await api.seedDemo();
      else await api.registerProject(regPath.trim());
      await refresh();
      setRegPath("");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  if (!projects.length && busy !== "register") {
    return (
      <>
        <Topbar path={["本机项目库", "注册项目"]} />
        <div className="content">
          <PageHead kicker="Get Started" title="注册一个 Git 项目开始使用" sub="ACB 在本地运行：项目注册表保存在本机，任何代码都不会离开你的设备。" />
          <Panel title="开始" icon={<FolderGit2 size={15} className="amber" />} corner>
            {err && <div className="notice warn" style={{ marginBottom: 14 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                value={regPath}
                onChange={(e) => setRegPath(e.target.value)}
                placeholder="输入 Git 仓库的本地绝对路径，如 D:\dev\my-project"
                style={{ flex: 1, background: "var(--panel-2)", border: "1px solid var(--line)", color: "var(--ink)", padding: "9px 12px", fontFamily: "var(--mono)", fontSize: 12.5 }}
              />
              <button className="btn primary" disabled={!regPath.trim() || busy !== null} onClick={() => void register(false)}>
                {busy === "register" ? <Loader size={14} /> : <Plus size={14} />} 注册项目
              </button>
            </div>
            <div className="xs faint" style={{ marginTop: 14 }}>
              没有合适的仓库？<button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void register(true)}>一键创建示例项目（含暂存/未暂存/新文件/删除的脏工作区）</button>
            </div>
          </Panel>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar path={["本机项目库", ov?.config.name ?? active?.name ?? "…", "总览"]} actions={
        <>
          <select
            value={active?.projectId ?? ""}
            onChange={(e) => setActiveId(e.target.value)}
            style={{ background: "var(--panel-2)", color: "var(--ink)", border: "1px solid var(--line)", padding: "5px 8px", fontFamily: "var(--mono)", fontSize: 12 }}
          >
            {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
          </select>
          <button className="btn sm ghost" onClick={() => void load()}><RefreshCw size={13} /> 刷新</button>
        </>
      } />
      <div className="content">
        <PageHead
          kicker="Project Overview"
          title="项目与任务总览"
          sub={<>当前项目 <span className="mono">{active?.name}</span> · 身份 <span className="mono amber">{active?.projectId}</span> · {ov?.tasks.length ?? 0} 个任务</>}
        />

        {err && <div className="notice warn" style={{ marginBottom: 16 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}
        {!ov && !err && <div className="muted"><Loader size={16} className="amber" style={{ animation: "spin 1s linear infinite" }} /> 加载中…</div>}

        {ov && (
          <>
            <div className="stat-row">
              <div className="stat"><div className="num">{ov.stats.changes}</div><div className="lbl">未提交改动（文件）</div></div>
              <div className="stat"><div className="num amber">{ov.stats.activeTasks}</div><div className="lbl">进行中任务</div></div>
              <div className="stat"><div className="num green">{ov.stats.published}</div><div className="lbl">已发布交接</div></div>
              <div className="stat"><div className="num">{ov.stats.forks}</div><div className="lbl">分叉待选择</div></div>
              <div className="stat"><div className="num red">{ov.stats.failedChecks}</div><div className="lbl">验证未通过</div></div>
            </div>

            <div className="grid g-12">
              <Panel title="任务" icon={<GitBranchPlus size={15} className="amber" />} tag={`tasks · ${ov.tasks.length}`} style={{ gridColumn: "span 7" }} bodyStyle={{ padding: 0 }}>
                {ov.tasks.length === 0 ? (
                  <div className="panel-body xs muted">尚无交接记录。右侧「以当前状态创建交接」即可封存第一个交接。</div>
                ) : (
                  <table className="tbl">
                    <thead><tr><th>任务</th><th>交接数</th><th>最近交接</th><th></th></tr></thead>
                    <tbody>
                      {ov.tasks.map((t) => (
                        <tr className="rowlink" key={t.taskId}>
                          <td><b>{t.taskName}</b><div className="xs faint mono">{t.taskId}</div></td>
                          <td><span className="badge">{t.handoffs.length} 个交接</span></td>
                          <td><span className="mono xs">{t.latestHandoff}</span><div className="xs faint">{fmtTime(t.handoffTime)}</div></td>
                          <td><Link to={`/handoff/${t.latestHandoff}`}><ChevronRight size={14} className="faint" /></Link></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>

              <Panel title="当前工作区状态" icon={<GitCommitVertical size={15} className="amber" />} tag="capture ready" corner style={{ gridColumn: "span 5" }}>
                <div className="mono xs muted" style={{ marginBottom: 12 }}>
                  基线 <code>{ov.branch ?? "(无)"} @ {ov.commit?.slice(0, 7) ?? "无"}</code>
                </div>
                <div className="li-row" style={{ padding: "10px 0" }}><span className="badge green">已暂存 {ov.dirty.staged}</span><span className="small muted">与 HEAD 不同的暂存改动</span></div>
                <div className="li-row" style={{ padding: "10px 0" }}><span className="badge amber">未暂存 {ov.dirty.unstaged}</span><span className="small muted">工作区修改（含删除）</span></div>
                <div className="li-row" style={{ padding: "10px 0" }}><span className="badge teal">新文件 {ov.dirty.untracked}</span><span className="small muted">未跟踪文件</span></div>
                <div className="li-row" style={{ padding: "10px 0" }}><span className="badge">排除 {ov.dirty.excluded.length} 类</span><span className="small muted">{ov.dirty.excluded.join("、")}（纳入策略）</span></div>
                <div className="notice warn" style={{ marginTop: 14 }}>
                  <TriangleAlert size={15} className="red" />
                  <div className="xs"><span className="red" style={{ fontWeight: 600 }}>.env 等凭据不在纳入范围。</span><span className="muted">必需但未纳入的文件会列入恢复要求，接收端需本机补齐。</span></div>
                </div>
                <button className="btn primary block" style={{ marginTop: 16 }} onClick={() => location.assign("#/create")}>
                  <GitBranchPlus size={15} /> 以当前状态创建交接
                </button>
              </Panel>

              <Panel title="最近交接" icon={<Package size={15} className="amber" />} tag="handoffs · 最新在前" style={{ gridColumn: "span 7", gridRow: "span 2" }} bodyStyle={{ padding: 0 }}>
                {ov.handoffs.length === 0 ? (
                  <div className="panel-body xs muted">暂无交接。</div>
                ) : (
                  <table className="tbl">
                    <thead><tr><th>交接 / 任务</th><th>快照</th><th>发布状态</th><th>验证状态</th><th>完整性</th></tr></thead>
                    <tbody>
                      {ov.handoffs.map((h) => (
                        <tr className="rowlink" key={h.handoffId}>
                          <td>
                            <Link to={`/handoff/${h.handoffId}`} className="mono xs amber" style={{ textDecoration: "none" }}>{h.handoffId}</Link>
                            <span> · {h.taskName}</span>
                            <div className="xs faint">{fmtTime(h.sealedAt)}</div>
                          </td>
                          <td className="mono xs">{h.snapshot}</td>
                          <td><span className={"badge " + h.publish.tone}>{h.publish.label}</span></td>
                          <td><span className={"badge " + h.verify.tone}>{h.verify.label}</span></td>
                          <td><span className={"badge " + h.integrity.tone}>{h.integrity.label}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="panel-body" style={{ borderTop: "1px solid var(--line)", padding: "10px 16px" }}>
                  <span className="xs faint">封存之后的交接不可原地更新；新证据产生新交接版本并保留父子关系。</span>
                </div>
              </Panel>

              <Panel title="分叉" icon={<GitFork size={15} className="amber" />} tag="fork" style={{ gridColumn: "span 5" }}>
                {ov.forksList.length === 0 ? (
                  <p className="xs muted">无分叉。两台电脑对同一父交接各自接续时会在此提示选择。</p>
                ) : (
                  ov.forksList.map((f) => (
                    <div key={f.parent} className="tcard claim">
                      父交接 <b className="mono">{f.parent}</b> 有 {f.children.length} 个后继：
                      <div className="meta">{f.children.map((c) => <span key={c}><Link className="mono amber" to={`/handoff/${c}`}>{c}</Link></span>)}</div>
                    </div>
                  ))
                )}
              </Panel>

              <Panel title="本机环境" icon={<MonitorCog size={15} className="amber" />} tag="observation" style={{ gridColumn: "span 5" }} bodyStyle={{ paddingTop: 8 }}>
                <div className="li-row" style={{ padding: "9px 0" }}><span className="mono xs muted" style={{ width: 110 }}>OS</span><span className="mono xs">{ov.dirty.env.os}</span><span className="badge green" style={{ marginLeft: "auto" }}>已记录</span></div>
                <div className="li-row" style={{ padding: "9px 0" }}><span className="mono xs muted" style={{ width: 110 }}>Runtime</span><span className="mono xs">{ov.dirty.env.node}</span><span className="badge green" style={{ marginLeft: "auto" }}>已记录</span></div>
                <div className="li-row" style={{ padding: "9px 0" }}><span className="mono xs muted" style={{ width: 110 }}>GitHub</span><span className="mono xs">{ov.config.githubRemote ?? "未配置远端"}</span><span className={"badge " + (ov.config.githubRemote ? "green" : "amber")} style={{ marginLeft: "auto" }}>{ov.config.githubRemote ? "已配置" : "待配置"}</span></div>
                <div className="li-row" style={{ padding: "9px 0" }}><span className="mono xs muted" style={{ width: 110 }}>检查命令</span><span className="mono xs">{ov.config.checks.length} 条</span><span style={{ marginLeft: "auto" }}><Link to="/create" className="btn sm ghost"><FlaskConical size={12} /> 在创建时执行</Link></span></div>
              </Panel>
            </div>

            <div className="footer-note">
              <span>ACB / 01-DASHBOARD</span>
              <span>观测 = Git/文件系统/环境探测</span>
              <span>验证记录绑定快照指纹</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
