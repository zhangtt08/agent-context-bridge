# ACB — Agent Context Bridge

A local tool for handing work between machines in multi-agent coding workflows: it packages a live project — git baseline, staged and working-tree state, check results — into an immutable handoff bundle that another machine (and another AI agent) can verify, restore and continue from, guided by an agent-readable `ACB-HANDOFF.md`.

跨机器项目上下文交接工具：把 Git 基线 + 暂存区 + 工作区 + 检查证据封装成不可变交接包，在另一台电脑上校验、恢复，并让 AI agent 借助 `ACB-HANDOFF.md` 接着干。

**English** | [简体中文](README.zh-CN.md)

![License](https://img.shields.io/badge/license-MIT-blue)
![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6)
![React](https://img.shields.io/badge/React-19-61DAFB)
![Express](https://img.shields.io/badge/Express-5-000000)
![Electron](https://img.shields.io/badge/desktop-Electron-47848F)

## Why

When you move AI coding work to another machine — or hand a half-finished task to another agent — a plain `git push` is not enough: uncommitted work, staged-but-uncommitted fixes, check/verification evidence and task context all fall through the cracks. ACB captures the full state of a project as an immutable handoff bundle (git baseline bundle + staged + working tree, including new/deleted/renamed files), publishes it either as a self-contained `*.acb.tar.gz` file or to a dedicated `acb/handoff/<id>` branch on GitHub, and restores it elsewhere with verification first — never overwriting a non-empty target, never executing anything from the package. The restored directory contains `ACB-HANDOFF.md`, written in reading order for an agent: goals, code mapping, evidence and limitations, blockers, key decisions, suggested next steps.

## ✨ Features

- **Create handoffs** — captures git baseline + staged area + working tree (including new files, deletions and renames) as an immutable snapshot; optionally runs the project's configured checks and records passed/failed/timeout/not-executed per check — failing tests never block archiving.
- **Publish two ways**:
  - **GitHub** — pushes to a dedicated handoff branch `acb/handoff/<id>` (code checkpoint + `.acb-meta` metadata + staged materials), generating fully before exposing the ref, then reading it back to confirm; re-publishing is idempotent (same SHA); your source branch, HEAD, index and worktree are never touched. Auth uses your machine's existing git credentials.
  - **Local file** — exports a self-contained `*.acb.tar.gz` (baseline git bundle, working-tree and staged restore materials, status, resume entry) you can carry on a USB stick.
- **Restore from three sources** — local handoff file, local archive records, or a GitHub handoff branch (the real cross-machine path). Everything is verified before extraction; a non-empty target directory blocks the restore.
- **Faithful reconstruction** — rebuilds baseline history from the git bundle, materializes baseline files, then restores staged and working-tree states separately (same-file staged+modified "MM" states don't clobber each other).
- **Resume Report** — after restore you get one of: can continue / environment needs setup / re-verification needed / restore blocked, with diffs and the actions needed to close the gap.
- **Agent-readable entry point** — `ACB-HANDOFF.md` presents goals, code correspondence, evidence and limitations, blockers, key decisions and suggested next steps in reading order.
- **Lineage** — handoffs record parent/child relationships; when two machines each continue from the same parent handoff, the overview page flags the fork.
- **Web UI + CLI + Electron desktop** — four screens (Overview / Create / Detail / Restore) in a light industrial theme, a CLI for scripted use, and a portable Electron desktop build.

## 🚀 Quick Start

**Prerequisites**: Node.js 20.19+ (22 LTS recommended), npm, git. For the GitHub publish path, the target repository must already exist and your local git credentials must be configured (e.g. Git Credential Manager).

```bash
git clone https://github.com/zhangtt08/agent-context-bridge.git
cd agent-context-bridge
npm install
npm run dev        # starts the API on :5174 and the frontend on :5173
```

Open http://localhost:5173, then either **drag your project folder into the window** (desktop build auto-resolves the real path), click **choose folder**, register a local git repository by absolute path on the Overview page — or click **one-click demo project** to experience the full loop.

CLI:

```bash
npm run cli -- overview                # projects & recent handoffs
npm run cli -- register <path> [name]  # register a project
npm run cli -- create [project] <task> # create a handoff
npm run cli -- publish [project] <id> local|github
npm run cli -- list [project] [remote] # list remote handoff branches
npm run cli -- restore <file.acb.tar.gz> [targetDir]
```

```bash
npm test    # end-to-end: dirty worktree → archive → export → cross-directory restore →
            # publish → branch restore → corrupted package blocked (32 assertions, temp dirs only)
```

A portable Electron desktop build (double-click `ACB.exe`) is described in [README-DESKTOP.txt](README-DESKTOP.txt) (Chinese).

## 🏗️ Architecture / How it works

Pipeline: **capture → verify → package → publish → restore**.

```
shared/types.ts        protocol types (shared by frontend and server)
server/core/           capture / verify / protocol / package / transport / resume / workflow / store
server/index.ts        Express API (:5174) — exports startServer; server/main.ts is the entry that listens
server/cli.ts          CLI entry
src/                   React frontend (4 screens: Overview / Create / Detail / Restore)
desktop/               Electron shell (main + preload)
tests/e2e.ts           end-to-end acceptance test
docs/                  product scope, protocol outline, roadmap, ADRs, glossary
```

Restore is verify-first: package integrity is checked before anything is extracted, baseline history is rebuilt from the git bundle, and staged vs. working-tree states are materialized separately. Excluded from snapshots by default: `.env*`, `node_modules/`, `dist/`, `.acb/` — anything excluded is honestly listed in the resume requirements rather than silently dropped.

## 🔒 Safety boundaries (honest scope)

- **No command execution from packages**: restoring never runs anything contained in a handoff bundle; check execution only ever uses the local project's own configuration.
- **No repo creation / credential management UI**: the GitHub remote must already exist; pushes use your machine's git credential helper.
- **No LFS or submodule support yet**; the publish path does not alter source branches, HEAD, the index or the working tree.
- Verified handoff loop (2026-09-30): local-file and GitHub paths were both tested end-to-end — create (with staged/unstaged/new/deleted files) → publish to `acb/handoff/<id>` (read-back confirmed, idempotent re-publish, source state untouched) → restore in a fresh directory from only the remote and the handoff ID (identical code fingerprint, separated staged state, `.env`-type exclusions honestly listed) → `ACB-HANDOFF.md` generated.

## 📄 License

[MIT](LICENSE)
