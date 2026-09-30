import { useCallback, useEffect, useState } from "react";
import {
  Fingerprint, ShieldCheck, ScanSearch, FlaskConical, MessageSquareQuote,
  GitFork, CloudCheck, Eye, FileArchive, RefreshCw, Loader,
  TriangleAlert, FileText,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { PageHead, Panel, Topbar } from "../components/Shell";
import { api, fmtTime, shortDigest, type HandoffRecord, type PublicationReceipt } from "../api";

export default function HandoffDetail() {
  const { id = "" } = useParams();
  const [data, setData] = useState<{ record: HandoffRecord; project: { name: string }; children: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pubBusy, setPubBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.handoff(id)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const publish = async (target: "github" | "local") => {
    setPubBusy(target);
    try {
      await api.publish(id, target);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setPubBusy(null);
  };

  if (err) {
    return (
      <>
        <Topbar path={["…", id]} />
        <div className="content">
          <div className="notice warn"><TriangleAlert size={15} className="red" /><div className="xs red">{err} — <Link className="amber" to="/">返回总览</Link></div></div>
        </div>
      </>
    );
  }
  if (!data) return <><Topbar path={["…", id]} /><div className="content"><Loader size={16} className="amber spin" /> 加载中…</div></>;

  const rec = data.record;
  const s = rec.state;
  const latestPub = rec.publications[rec.publications.length - 1];
  const exported = rec.publications.find((p) => p.target === "local" && p.state === "已发布");
  const isPublished = rec.publications.some((p) => p.target === "github" && p.state === "已发布");

  return (
    <>
      <Topbar path={[data.project.name, s.taskName, id]} actions={
        <>
          {isPublished
            ? <span className="pill green"><span className="dot" /> 已发布 · 读取确认 ✓</span>
            : <span className="pill"><span className="dot" /> 未发布到远端</span>}
          {latestPub && latestPub.state === "失败" && <span className="pill red"><span className="dot" /> 最近发布失败</span>}
          <button className="btn sm ghost" disabled={pubBusy !== null || !!exported} onClick={() => void publish("local")}>
            {pubBusy === "local" ? <Loader size={13} className="spin" /> : <FileArchive size={13} />} {exported ? "已导出" : "导出文件"}
          </button>
          <button className="btn sm" disabled={pubBusy !== null} onClick={() => void publish("github")}>
            {pubBusy === "github" ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />} 幂等重试发布
          </button>
        </>
      } />
      <div className="content">
        <PageHead
          kicker="Handoff Detail"
          title="交接详情"
          monoId={id}
          sub={<>封存于 {fmtTime(rec.sealedAt)} · 协议 {s.protocolVersion} · 由 <span className="mono">{s.toolVersion}</span> 生成{s.parentHandoffIds.length ? <> · 父交接 {s.parentHandoffIds.map((p) => <Link key={p} className="mono amber" to={`/handoff/${p}`}>{p}</Link>)}</> : null}{data.children.length ? <> · 后继 {data.children.map((c) => <Link key={c} className="mono amber" to={`/handoff/${c}`}>{c}</Link>)}</> : null}</>}
        />

        <div className="grid g-12" style={{ marginBottom: 18 }}>
          <Panel title="身份与快照" icon={<Fingerprint size={15} className="amber" />} tag="immutable" corner style={{ gridColumn: "span 8" }}>
            <dl className="kv" style={{ gridTemplateColumns: "repeat(2, 128px 1fr)", columnGap: 28 }}>
              <dt>project_id</dt><dd className="mono">{s.projectId}</dd>
              <dt>task_id</dt><dd className="mono">{s.taskId} · {s.taskName}</dd>
              <dt>snapshot_id</dt><dd className="mono">{s.snapshotId}（不可变）</dd>
              <dt>source_digest</dt><dd className="mono amber">{shortDigest(s.sourceDigest)}</dd>
              <dt>Git 基线</dt><dd className="mono">{s.baseline.branch ?? "(无)"} @ {s.baseline.commit?.slice(0, 7) ?? "无"}</dd>
              <dt>纳入范围</dt><dd className="mono">{s.changes.length} 文件（{s.changes.filter((c) => c.staged).length} 含暂存材料）</dd>
              <dt>会话来源</dt><dd className="mono">{s.claims[0]?.sessionId ?? "—"}</dd>
              <dt>必需能力</dt><dd className="mono">{s.capabilities.join(" · ")}</dd>
            </dl>
          </Panel>
          <Panel title="完整性" icon={<ShieldCheck size={15} className="amber" />} tag="package" style={{ gridColumn: "span 4" }} bodyStyle={{ paddingTop: 10 }}>
            <div className="li-row" style={{ padding: "8px 0" }}><span className="badge green">包清单摘要 ✓</span><span className="xs muted">清单无自引用，摘要外置</span></div>
            <div className="li-row" style={{ padding: "8px 0" }}><span className="badge green">代码恢复材料 ✓</span><span className="xs muted" style={{ marginLeft: 8 }}>基线 + 工作区 + 暂存</span></div>
            {s.recoveryRequirements.length === 0
              ? <div className="li-row" style={{ padding: "8px 0" }}><span className="badge teal">无缺口</span><span className="xs muted" style={{ marginLeft: 8 }}>无接收端需补齐项</span></div>
              : s.recoveryRequirements.map((r) => (
                <div className="li-row" key={r} style={{ padding: "8px 0" }}><span className="badge red">恢复要求</span><span className="xs muted" style={{ marginLeft: 8 }}>{r}</span></div>
              ))}
            <div className="li-row" style={{ padding: "8px 0" }}>
              <span className="badge teal">排除 {s.excluded.length}</span>
              <span className="xs muted" style={{ marginLeft: 8 }}>{s.excluded.length ? s.excluded.join("、") : "无排除项"}</span>
            </div>
          </Panel>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 18 }}>
          <Panel title="观测" icon={<ScanSearch size={15} className="teal" />} tag="git / fs / env" headExtra={<span className="badge teal">OBSERVATION · {s.observations.length}</span>} bodyStyle={{ padding: 0 }}>
            <div className="trust-head hl-teal"><span className="t">来自工具的事实</span><span className="c">OBSERVATION</span></div>
            <div className="trust-body">
              {s.observations.map((o, i) => (
                <div className="tcard obs" key={i}>{o.text}<div className="meta"><span>{fmtTime(o.at)}</span><span>范围: {o.scope}</span><span>{o.source}</span></div></div>
              ))}
            </div>
          </Panel>

          <Panel title="验证记录" icon={<FlaskConical size={15} className="green" />} tag="exit codes" headExtra={<span className={"badge " + (s.verifications.some((v) => v.result !== "通过" && v.result !== "未执行") ? "red" : s.verifications.length ? "green" : "")}>VERIFIED · {s.verifications.length}</span>} bodyStyle={{ padding: 0 }}>
            <div className="trust-head hl-green"><span className="t">绑定快照的检查结果</span><span className="c">VERIFICATION</span></div>
            <div className="trust-body">
              {s.verifications.length === 0 && <div className="xs faint">本次未执行检查。</div>}
              {s.verifications.map((v) => (
                <div className={"tcard ver" + (v.result === "通过" ? "" : " bad")} key={v.checkId}>
                  <b>{v.name}</b> · {v.result} · 退出码 {v.exitCode ?? "-"}
                  <div className="meta"><span>{v.snapshotId}</span><span>{v.durationMs}ms</span></div>
                  {v.logTail && <details className="xs faint" style={{ marginTop: 6 }}><summary style={{ cursor: "pointer" }}>日志尾部</summary><pre className="mono xs" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{v.logTail}</pre></details>}
                </div>
              ))}
              <div className="xs faint" style={{ padding: "2px 2px 0" }}>验证结果仅证明该检查在该快照与环境上的结果，不自动扩展为全部功能正确。</div>
            </div>
          </Panel>

          <Panel title="Agent 声明" icon={<MessageSquareQuote size={15} className="amber" />} tag={`${s.claims.filter((c) => !c.evidence).length} 待确认`} headExtra={<span className="badge amber">CLAIM · {s.claims.length}</span>} bodyStyle={{ padding: 0 }}>
            <div className="trust-head hl-amber"><span className="t">工作解释与建议</span><span className="c">CLAIM</span></div>
            <div className="trust-body">
              {s.claims.length === 0 && <div className="xs faint">无声明记录。</div>}
              {s.claims.map((c, i) => (
                <div className="tcard claim" key={i}>
                  {c.text}
                  {c.evidence ? <span className="badge green" style={{ marginLeft: 6 }}>关联证据</span> : <span className="badge amber" style={{ marginLeft: 6 }}>待确认</span>}
                  <div className="meta"><span>{c.sessionId}</span><span>{fmtTime(c.at)}</span>{c.evidence && <span>→ {c.evidence}</span>}</div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="grid g-12">
          <Panel title="交接谱系" icon={<GitFork size={15} className="amber" />} tag="parent / child" style={{ gridColumn: "span 7" }}>
            <svg viewBox="0 0 560 190" style={{ width: "100%", display: "block" }}>
              <g stroke="var(--line-strong)" strokeWidth="1.5" fill="none">
                {s.parentHandoffIds.length > 0 && <line x1="120" y1="95" x2="215" y2="95" />}
                {data.children.length > 0 && <line x1="330" y1="95" x2="425" y2="95" />}
              </g>
              {s.parentHandoffIds.length > 0 && (
                <>
                  <circle cx="70" cy="95" r="7" fill="var(--bg)" stroke="var(--faint)" strokeWidth="2" />
                  <text x="40" y="122" fill="var(--muted)" fontFamily="IBM Plex Mono" fontSize="10.5">{s.parentHandoffIds[0]}</text>
                  <text x="28" y="138" fill="var(--faint)" fontSize="10" fontFamily="Noto Sans SC">父交接</text>
                </>
              )}
              <circle cx="280" cy="95" r="9" fill="var(--bg)" stroke="var(--amber)" strokeWidth="2.5" />
              <circle cx="280" cy="95" r="3" fill="var(--amber)" />
              <text x="248" y="70" fill="var(--amber)" fontFamily="IBM Plex Mono" fontSize="11" fontWeight="600">{rec.handoffId}</text>
              <text x="234" y="122" fill="var(--muted)" fontSize="10" fontFamily="Noto Sans SC">本机 · 当前查看</text>
              {data.children.length > 0 ? (
                <>
                  <circle cx="475" cy="95" r="7" fill="var(--bg)" stroke="var(--green)" strokeWidth="2" />
                  <text x="440" y="122" fill="var(--muted)" fontFamily="IBM Plex Mono" fontSize="10.5">{data.children[0]}</text>
                  <text x="452" y="138" fill="var(--faint)" fontSize="10" fontFamily="Noto Sans SC">后继交接</text>
                </>
              ) : (
                <>
                  <circle cx="475" cy="95" r="7" fill="var(--bg)" stroke="var(--line-strong)" strokeWidth="2" strokeDasharray="3 3" />
                  <text x="442" y="122" fill="var(--faint)" fontFamily="IBM Plex Mono" fontSize="10.5">后继（未来）</text>
                </>
              )}
            </svg>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              {s.parentHandoffIds.map((p) => (
                <button key={p} className="btn sm ghost" onClick={() => location.assign(`#/handoff/${p}`)}><Eye size={12} /> 查看父交接 {p}</button>
              ))}
            </div>
          </Panel>

          <Panel title="发布回执" icon={<CloudCheck size={15} className="amber" />} tag="publication" style={{ gridColumn: "span 5" }} bodyStyle={{ paddingTop: 10 }}>
            {rec.publications.length === 0 && <div className="xs muted">尚未发布。可在创建页或上方按钮执行发布。</div>}
            {rec.publications.slice().reverse().map((p: PublicationReceipt, i) => (
              <dl className="kv" key={i} style={{ marginBottom: 10 }}>
                <dt>{p.target === "github" ? "GitHub 发布" : "本地导出"}</dt>
                <dd>
                  <span className={"badge " + (p.state === "已发布" ? "green" : "red")}>{p.state}</span>
                  <div className="mono xs muted" style={{ marginTop: 4 }}>{p.location}</div>
                  {p.commitSha && <div className="mono xs faint">提交 {p.commitSha.slice(0, 10)} · 读取确认 {p.readBackConfirmed ? "✓" : "✗"} · {p.attempts} 次尝试</div>}
                  {p.error && <div className="xs red">{p.error}</div>}
                </dd>
              </dl>
            ))}
            <div className="xs muted" style={{ marginTop: 6, padding: "10px 12px", background: "var(--panel-2)", border: "1px solid var(--line)" }}>
              发布采用“先完整生成、再暴露引用、再读取确认”。代码上传成功 ≠ 发布完成；读取确认全部必需材料后才标记已发布。
            </div>
            {exported && <div className="xs faint" style={{ marginTop: 8 }}><FileText size={11} style={{ display: "inline" }} /> 归档文件：{exported.location}</div>}
          </Panel>
        </div>

        <div className="footer-note">
          <span>ACB / 03-DETAIL</span>
          <span>观测 ≠ 声明 ≠ 验证记录</span>
          <span>封存内容不可原地更新</span>
        </div>
      </div>
    </>
  );
}
