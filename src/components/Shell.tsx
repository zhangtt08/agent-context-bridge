import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Package, CloudUpload, MonitorDown, Settings2,
  HardDrive, Sun, Moon, GitBranchPlus,
} from "lucide-react";
import { useProject } from "../state";
import { api } from "../api";
import type { ReactNode } from "react";

export function Rail({ theme, onToggleTheme }: { theme: "light" | "dark"; onToggleTheme: () => void }) {
  const { active } = useProject();
  const [latestHandoff, setLatestHandoff] = useState<string | null>(null);

  // 侧边栏「交接详情」指向当前项目最新交接；无项目/无交接时回到总览
  useEffect(() => {
    let cancelled = false;
    setLatestHandoff(null);
    if (!active) return;
    void api.overview(active.projectId).then((o) => {
      if (!cancelled) setLatestHandoff(o.handoffs[0]?.handoffId ?? null);
    }).catch(() => { /* 总览不可用时维持回退链接 */ });
    return () => { cancelled = true; };
  }, [active?.projectId, active?.githubRemote]);

  const detailTo = latestHandoff ? `/handoff/${latestHandoff}` : "/";

  return (
    <aside className="rail">
      <div className="logo" onClick={() => location.assign("#/")}>ACB</div>
      <NavLink to="/" end className={({ isActive }) => "nav" + (isActive ? " active" : "")} title="项目总览">
        <LayoutDashboard size={17} />
      </NavLink>
      <NavLink to={detailTo} className={({ isActive }) => "nav" + (isActive ? " active" : "")} title={latestHandoff ? "交接详情（最新）" : "交接详情（暂无交接）"}>
        <Package size={17} />
      </NavLink>
      <NavLink to="/create" className={({ isActive }) => "nav" + (isActive ? " active" : "")} title="创建交接">
        <CloudUpload size={17} />
      </NavLink>
      <NavLink to="/resume" className={({ isActive }) => "nav" + (isActive ? " active" : "")} title="恢复">
        <MonitorDown size={17} />
      </NavLink>
      <a className="nav" title="设置"><Settings2 size={17} /></a>
      <div className="spacer" />
      <div className="rail-tag">LOCAL · NO CLOUD MIDDLEMAN</div>
      <button className="theme-toggle" onClick={onToggleTheme} title="切换主题">
        {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </aside>
  );
}

export function Topbar({ path, actions }: { path: string[]; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="crumb">
        <HardDrive size={14} />
        {path.map((seg, i) => (
          <span key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {i > 0 && <span className="sep">/</span>}
            {i === path.length - 1 ? <b>{seg}</b> : <span>{seg}</span>}
          </span>
        ))}
      </div>
      <div className="right">
        {actions}
        <NavCreateButton />
      </div>
    </header>
  );
}

function NavCreateButton() {
  const loc = useLocation();
  if (loc.pathname.startsWith("/create")) return null;
  return (
    <button className="btn primary sm" onClick={() => location.assign("#/create")}>
      <GitBranchPlus size={14} /> 创建交接
    </button>
  );
}

export function PageHead({ kicker, title, monoId, sub }: { kicker: string; title: string; monoId?: string; sub?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <div className="kicker">{kicker}</div>
        <h1>
          {title}
          {monoId && <span className="mono-id"> {monoId}</span>}
        </h1>
      </div>
      {sub && <p className="sub">{sub}</p>}
    </div>
  );
}

export function Panel({ title, icon, tag, corner, children, headExtra, style, bodyStyle }: {
  title: ReactNode;
  icon?: ReactNode;
  tag?: string;
  corner?: boolean;
  children: ReactNode;
  headExtra?: ReactNode;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}) {
  return (
    <section className="panel" style={style}>
      {corner && <div className="corner" />}
      <div className="panel-head">
        {icon}
        <h3>{title}</h3>
        {headExtra}
        {tag && <span className="tag">{tag}</span>}
      </div>
      <div className="panel-body" style={bodyStyle}>{children}</div>
    </section>
  );
}
