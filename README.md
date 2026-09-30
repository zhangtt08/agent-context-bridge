# ACB — Agent Context Bridge

面向多 AI Coding Agent 工作流的本地项目上下文交接工具。让另一台电脑上的另一个 Agent 获得对应的代码、项目状态与验证证据，继续未完成的任务。

> 架构文档见 `docs/`（产品范围、协议轮廓、开发路线、ADR、术语表）。

## 启动

```bash
npm install
npm run dev        # 同时启动 API(:5174) 与前端(:5173)，浏览器打开 http://localhost:5173
```

首次使用：在总览页输入本地 Git 仓库绝对路径注册项目，或点「一键创建示例项目」体验完整闭环。

## 功能

- **创建交接**：捕获 Git 基线 + 暂存区 + 工作区（含新文件/删除/重命名）为不可变快照，可选执行已配置检查（通过/失败/超时/未执行分别记录），封装为带包清单与摘要的交接包并封存。失败测试不妨碍封存。
- **发布**：
  - GitHub：推送到专用交接分支 `acb/handoff/<id>`（代码检查点 + `.acb-meta` 元数据 + 暂存材料），先完整生成、再暴露引用、再读取确认；重复发布幂等（同一 SHA）；不改变源端分支/HEAD/暂存区/工作区。远端 URL 在项目配置中设置，鉴权使用本机 git 凭据。
  - 本地文件：导出自包含 `*.acb.tar.gz`（含基线 git bundle、工作区与暂存恢复材料、状态、接手入口）。
- **恢复**（三种来源，先校验后展开，目标目录非空即阻止）：
  - 本地交接文件 / 本机封存记录 / GitHub 交接分支（真正的跨电脑路径）。
  - 重建基线历史（git bundle）、物化基线文件、分别恢复暂存与工作区状态（同文件 MM 互不覆盖）。
  - 生成 Resume Report：可继续 / 需要配置环境 / 需要重新验证 / 恢复被阻塞，附差异与补齐动作。
- **接手入口**：`ACB-HANDOFF.md` 按阅读顺序呈现目标、代码对应关系、证据与局限、阻塞、关键决策、建议下一步——Agent 可直接阅读。
- **谱系**：交接记录 parent/child 关系，两台电脑对同一父交接各自接续时在总览页提示分叉。

## CLI

```bash
npm run cli -- overview                # 项目与最近交接
npm run cli -- register <path> [name]  # 注册项目
npm run cli -- create [project] <task> # 创建交接
npm run cli -- publish [project] <id> local|github
npm run cli -- list [project] [remote] # 列出远端交接分支
npm run cli -- restore <file.acb.tar.gz> [targetDir]
```

## 测试

```bash
npm test    # 端到端：脏工作区→封存→导出→异目录恢复→发布→分支恢复→损坏包阻止（32 项断言，隔离在临时目录，不污染 ~/.acb）
```

已验证的交接闭环（2026-09-30）：本地文件路径与 GitHub 路径均实测通过——创建交接（含暂存/未暂存/新文件/删除）→ 发布 `acb/handoff/<id>`（回读确认、重复发布幂等、不改源端分支/HEAD/暂存区/工作区）→ 仅凭远端与交接 ID 在全新目录恢复（代码指纹一致、暂存状态分离、`.env` 等排除项如实列入恢复要求）→ 生成 `ACB-HANDOFF.md` 接手入口。

## 结构

```
shared/types.ts        协议类型（前后端共享）
server/core/           capture / verify / protocol / package / transport / resume / workflow / store
server/index.ts        Express API（:5174）
server/cli.ts          命令行入口
src/                   React 前端（四屏：总览 / 创建 / 详情 / 恢复；亮色工业风主题）
tests/e2e.ts           端到端验收测试
```

## 已知边界（对应架构文档的后续阶段）

- GitHub 建仓/凭据管理 UI 未做：远端需已存在，push 使用本机 git 凭据助手。
- LFS、子模块等特殊 Git 能力未支持；纳入策略默认排除 `.env*`、`node_modules/`、`dist/`、`.acb/`。
- 恢复不执行外来包中的任何命令；检查执行仅使用本机项目配置。
