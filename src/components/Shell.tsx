import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard, Package, CloudUpload, MonitorDown, Settings2,
  HardDrive, Sun, Moon, GitBranchPlus, Minus, Square, Copy, X,
} from "lucide-react";
import { useProject } from "../state";
import { api, pathFromDrop, windowControls } from "../api";

/** 拖放区：拖入文件后回调本机路径（桌面版）；拖悬时显示遮罩提示 */
export function DropArea({ onPath, hint, children }: { onPath: (p: string | null) => void; hint: string; children: ReactNode }) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className="drop-wrap"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onPath(pathFromDrop(e.dataTransfer.files?.[0])); }}
    >
      {children}
      {drag && <div className="drop-overlay">{hint}</div>}
    </div>
  );
}

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
      <NavLink to="/settings" className={({ isActive }) => "nav" + (isActive ? " active" : "")} title="项目设置（GitHub 远端 / 检查命令）">
        <Settings2 size={17} />
      </NavLink>
      <div className="spacer" />
      <div className="rail-tag">LOCAL · NO CLOUD MIDDLEMAN</div>
      <button className="theme-toggle" onClick={onToggleTheme} title="切换主题">
        {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </aside>
  );
}

/** 窗口三键：最小化/最大化(还原)/关闭。仅在 Electron 桌面壳（frameless）中渲染 */
function WindowControls() {
  const controls = windowControls();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let alive = true;
    void controls.isMaximized().then((v) => { if (alive) setMaximized(v); }).catch(() => { /* 降级为默认图标 */ });
    const unsubscribe = controls.onMaximizedChange(setMaximized);
    return () => { alive = false; unsubscribe(); };
  }, [controls]);

  if (!controls || /Mac/i.test(navigator.platform)) return null;

  return (
    <div className="win-controls">
      <button type="button" className="win-btn" title="最小化" onClick={() => void controls.minimize().catch(() => {})}>
        <Minus size={15} />
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? "向下还原" : "最大化"}
        onClick={() => void controls.toggleMaximize().catch(() => {})}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button type="button" className="win-btn close" title="关闭" onClick={() => void controls.close().catch(() => {})}>
        <X size={15} />
      </button>
    </div>
  );
}

export function Topbar({ path, actions }: { path: string[]; actions?: ReactNode }) {
  // frameless 窗口：topbar 即标题栏，双击空白处切换最大化（双击按钮等控件时不触发）
  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, a, input, select")) return;
    void windowControls()?.toggleMaximize().catch(() => {});
  };
  return (
    <header className="topbar" onDoubleClick={onDoubleClick}>
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
      <WindowControls />
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
