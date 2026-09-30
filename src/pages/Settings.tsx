import { useCallback, useEffect, useState } from "react";
import { Settings2, Plus, Loader, Trash2, Check, FolderGit2 } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHead, Panel, Topbar } from "../components/Shell";
import { useProject } from "../state";
import { api, type ProjectConfig } from "../api";

export default function Settings() {
  const { active, projects, setActiveId } = useProject();
  const [cfg, setCfg] = useState<ProjectConfig | null>(null);
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [checks, setChecks] = useState<{ name: string; cmd: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!active) { setCfg(null); return; }
    try {
      const c = await api.config(active.projectId);
      setCfg(c); setName(c.name); setRemote(c.githubRemote ?? "");
      setChecks(c.checks.length ? c.checks.map((x) => ({ ...x })) : []);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [active]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!active) return;
    setBusy(true); setSaved(false);
    try {
      await api.saveConfig(active.projectId, {
        name: name.trim() || undefined,
        githubRemote: remote.trim(),
        checks: checks.filter((c) => c.name.trim() && c.cmd.trim()),
      });
      setSaved(true); setErr(null);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <>
      <Topbar path={[active?.name ?? "…", "项目设置"]} />
      <div className="content">
        <PageHead
          kicker="Settings"
          title="项目设置"
          sub="GitHub 远端用于跨电脑交接；检查命令在每次创建交接时执行，失败也会如实封存。"
        />

        {!active ? (
          <Panel title="设置" icon={<Settings2 size={15} className="amber" />}>
            <p className="xs muted">还没有注册项目。先到 <Link className="amber" to="/">总览</Link> 注册一个 Git 项目。</p>
          </Panel>
        ) : (
          <div className="grid g-12" style={{ alignItems: "start" }}>
            <Panel title="选择项目" icon={<FolderGit2 size={15} className="amber" />} style={{ gridColumn: "span 4" }}>
              <select
                value={active?.projectId ?? ""}
                onChange={(e) => setActiveId(e.target.value)}
                style={{ width: "100%", background: "var(--panel-2)", color: "var(--ink)", border: "1px solid var(--line)", padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 12.5 }}
              >
                {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
              </select>
              <div className="xs faint" style={{ marginTop: 10 }}>身份 <span className="mono">{active?.projectId}</span></div>
            </Panel>

            <Panel title="常规与跨电脑" icon={<Settings2 size={15} className="amber" />} corner style={{ gridColumn: "span 8" }}>
              {err && <div className="notice warn" style={{ marginBottom: 14 }}><div className="xs red">{err}</div></div>}
              {cfg && (
                <>
                  <div className="xs muted" style={{ marginBottom: 5 }}>项目名称</div>
                  <input className="acb-input" value={name} onChange={(e) => setName(e.target.value)} />

                  <div className="xs muted" style={{ margin: "14px 0 5px" }}>GitHub 远端（跨电脑交接用，留空则只能用本地文件交接）</div>
                  <input className="acb-input mono" value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="https://github.com/you/your-repo.git" />
                  <div className="xs faint" style={{ marginTop: 6 }}>
                    需要是已存在的仓库；推送使用本机 git 凭据。交接会推到该仓库的 <span className="mono">acb/handoff/&lt;交接ID&gt;</span> 分支，不影响你的分支。
                  </div>

                  <div className="xs muted" style={{ margin: "14px 0 5px" }}>检查命令（创建交接时执行，如测试/构建）</div>
                  {checks.map((c, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <input className="acb-input" style={{ width: 180 }} value={c.name} placeholder="名称，如 测试"
                        onChange={(e) => setChecks(checks.map((x, k) => k === i ? { ...x, name: e.target.value } : x))} />
                      <input className="acb-input mono" style={{ flex: 1 }} value={c.cmd} placeholder="命令，如 npm test"
                        onChange={(e) => setChecks(checks.map((x, k) => k === i ? { ...x, cmd: e.target.value } : x))} />
                      <button className="btn sm ghost" title="删除此检查" onClick={() => setChecks(checks.filter((_, k) => k !== i))}><Trash2 size={13} /></button>
                    </div>
                  ))}
                  <button className="btn sm ghost" onClick={() => setChecks([...checks, { name: "", cmd: "" }])}><Plus size={13} /> 添加检查</button>

                  <button className="btn primary" style={{ marginTop: 18 }} disabled={busy} onClick={() => void save()}>
                    {busy ? <Loader size={14} /> : saved ? <Check size={14} className="green" /> : null} {saved ? "已保存" : "保存设置"}
                  </button>
                </>
              )}
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
