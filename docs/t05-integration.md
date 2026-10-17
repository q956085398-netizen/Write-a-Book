# T05 本地整合与真实 Windows 验收

2026-10-17，Issue #6。实现提交 `41ae8be1cf156cb2bf32dd9f4d2a74b235a5b143` 已快进整合到本地 main；本轮尚未推送、回填或关闭 #6。此前授权覆盖的 #37 已发布关闭，#4 仍开放。

## 分工、复杂度与复核

最新无阻塞未分配候选为 #6、#12、#13；优先选择 #6。三者都触及正文身份、资料库、附件和导航，故本批只启动一个 Issue，避免并发修改同一文件。#6 涉及旧库迁移、跨模块结构变更、事务失败保全和稳定身份，风险及所需推理深度较高。

独立 worktree `issue-6-volumes-fragments/Write-a-Book`、分支 `codex/issue-6-volumes-fragments`，基线为已发布 `9281d91`。实现代理使用 gpt-6.1-sol/xhigh，自行读取必需代码并完成实现及测试。原代理在 19 个文件已暂存后遇到模型用量限制；停止其写入后，仅由 gpt-6-luna/low 核对已完成的索引并提交，没有让快速档重新实现高风险逻辑。两个代理顺序工作。主会话独立检查迁移、结构事务、恢复兼容、附件身份、保存屏障和组件接入，复测后串行开展原生验收。

实现修改 19 个文件：README 与 `t05-works-structure.md`；Rust 的 `lib.rs`、`library.rs`、`library/attachments.rs`、`library/recovery.rs`，新增 `library/schema.rs`、`library/structure.rs`；前端 `App.tsx`、`RecoveryPanel.tsx`、`RichEditor.tsx`、`application.ts`、`editor-session.ts`、`model.ts`、`styles.css`，新增 `App.structure.test.tsx`、`StructureDialog.tsx`、`WorkShelf.tsx`、`WritingDirectory.tsx`。本整合补充文档并更正上一批的发布状态，没有另改产品代码。

## 自动检查

主会话在本地 main、签入 Windows 用户的逐命令审批环境复测：前端 62/62（10 文件）、Rust 33/33 全部通过。TypeScript/Vite 生产前端、隔离标识原生 debug 构建、正式标识 release 构建及 Rust 格式检查通过。保留既有 Tiptap use-client、大脚本、Cargo PDB 同名与尚无产品入口的公开备份 DTO dead-code 提示。

实际验收 debug 程序另存本机 `native/verified-batch4-test.exe`，SHA-256 为 `ABA03D628AA18DD0C91D75EEC66A917853D906A8248EF46C8692A01939138BAB`。正式 `src-tauri/target/release/write-a-book.exe` 的 SHA-256 为 `05D5102ED802B8DBB18B2F36AC9E5026C6C1343DF08DBC43C9DD494B39DFC879`；仅完成构建，没有启动正式配置、生成新安装包或宣称 release GUI 已另测。

受控测试涵盖 schema 1/2 迁移、同名记录、额外元数据和旧恢复日志、迁移失败原数据库字节保持、目录过期与跨作品拒绝、结构失败回滚、图文同身份编章、重开、未编章片段失败保存与冲突副本。组件测试验证实际 App 的保存屏障和结构失败重试。它们不替代实际磁盘耗尽、断电、候选焦点或多窗口真人并发验收。

## 真实 Windows 操作

使用本机 Tauri/WebView2 debug EXE、1280×860 配置窗口；仅覆盖 productName/identifier，独立标识 `net.writeabook.batch4test`。资料库和所有内容均为虚构 fixture，位于 `.scratch/issue-batch-20261017/native/legacy-library`。旧库及额外元数据由脚本预置；以下作者动作实际在原生界面完成，不是直接调用后端命令。

1. 启动前为 schema 2，包含两部完全同名作品、三章、两张受管图片及自定义字段/表。启动后实际打开“迁移验收末章”；立即核对 schema 3，所有旧作品/章节/正文/版本/附件行、稳定身份及图片 SHA-256 与基线逐项相等。额外元数据、原继续位置和外键完整性保留。
2. 通过界面新建“暂名·第三部”，进入第一章；新增“卷甲”“卷乙”，上移卷乙。新增“待编片段”，输入“先写下的片段正文，编章后仍应完整。”，从原生文件选择器导入测试 PNG。之后移动原图片源文件，未操作资料库附件。
3. 在片段仍打开时，把第一章从顶层移动至卷甲。保存完成后记录编章前全库逻辑快照；仅测试库加入拒绝更新 kind 的 SQLite 触发器。
4. 选择“编为新章节”，目标卷甲、第一章之前。确认后原生界面持续显示失败，保留原正文、片段身份、对话框及两项选择。脚本核对全库正文、目录、结构版本、继续位置、附件和图片哈希与失败前快照完全相等。移除仅测试触发器后，从同一对话框重试成功。
5. 编章后同一 entry id/contentId 成为章节，正文 revision、完整结构化图文、附件身份与文件哈希保持；章节总数没有产生重复正文。随后下移该章节、上移卷甲，界面顺序随真实回执变化。
6. 书架与紧凑列表展示相同的三部作品及各自继续位置。从列表回到第一部同名作品得到“迁移验收末章”；切换另一部同名作品得到其原图文章；返回新作品仍在已编章正文。
7. 再通过界面新建“保留未编章片段”，正常关闭程序，确认窗口退出后重启。实际恢复到该片段，标题和正文标签仍为片段；卷甲/卷乙、卷内第一章/已编章正文的顺序保留。选择已编章正文，原句和图片可见；导入源文件已经移动。
8. 再次正常退出。最终数据库完整性与外键检查通过，原正文和附件集合及哈希保持，编章结果唯一，独立未编章条目保留，受控故障触发器已移除。正式应用 settings.sqlite3 SHA-256 与验收前一致；既有 38 个未跟踪文件哈希全部一致。

本机证据仅存于忽略的 `.scratch/issue-batch-20261017/native/`，没有外发截图：`migration-verification.json`、`before-compile-db.json`、`compiled-db.json`、`final-db.json`，以及 `fragment-before-compile`、`controlled-compile-failure`、`works-shelf`、`works-compact-list`、`reopened-uncompiled-fragment`、`reopened-compiled-image` 的 PNG/可访问树。`verify-migration.py` 和 `verify-structure.py` 只检查虚构库与注入受控故障，不是 GUI 自动回归测试。截图未纳入仓库，文中的证据结论由本次本机验收得出。

## 设计与未验证项

本轮用户授权只外发候选 A 和纯虚构功能说明，并允许转换故障时沿用现有 A。12ui 新图 a/b/d 已查看；紧凑列表 c 生成失败，新页面转换均为上游不可用，未取得新 HTML。沿用 A 的实际实现按授权回退交付，最终外部设计核对与像素一致性未验证；没有外发代码、真实资料或本轮原生截图。

本轮没有验收最小窄窗口、重新安装/升级/卸载，也没有实现导出、净增、历史、搜索、回收站或完整备份。后续接入必须保留稳定内容身份及图文附件，并遵守 [T05 移动语义](t05-works-structure.md)。schema 3 资料库须由支持该版本的应用打开，不能把旧安装包作为降级读取手段。

## #4 的补充诊断

本轮在独立诊断 EXE 的复制前端中添加只读 DOM 事件观察器，未修改产品代码。可见的 Microsoft 拼音 n/ni 候选路径没有记录到 compositionstart/update/end；点击 API 记录了鼠标、失焦与点击。显式空格确认输入产生 trusted insertText/input，数据长度 1。故不能继续断言“compositionend 提前结束”是已证实原因，也不能把没有 DOM 组合事件当成候选保护已通过。IPC 包装未成功，未取得销毁/IPC 拦截证据。

诊断只证明这次观察的边界，不能推广到所有物理输入、工具输入和输入法配置。虚构标题已还原，恢复图文不变，程序正常退出；#4 保持开放，候选焦点保护未验证。
