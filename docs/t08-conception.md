# T08 自由构思与作品分区

主会话现已串行接入 App 与 Tauri 命令，图文编辑复用 RichEditor；全量检查、真实 Windows 保存失败/关闭/重开及分区验收见 [本批整合记录](t08-t44-t46-integration.md)。下文“当前证据”保留独立代理交付时的验证范围，不代表最终整合仍未接通。

## 作者行为与保存范围

- 新建构思直接创建空记录，不必填写人物表、大纲或任何理论模板。标题可空；可选提示默认折叠，只提供作者可展开阅读的提示，不生成或插入创作内容。正文写作与构思没有前置依赖。
- 候选分区为故事核心、人物与关系、世界与设定、剧情储备、大纲与细纲、伏笔与线索、本书参考。可以改名、调整次序、显示或隐藏、增加自定义分区；空分区可移除。含引用的分区只能隐藏，避免让原内容失去入口。
- 当前作品设置始终显示书名，只影响本书。新作品默认值是**当前资料库**中以后创建作品采用的候选组合，可以增减至空组合；保存不会回写已有作品。每个新作品得到独立分区身份和配置。
- 隐藏仅改变普通目录。设置的“打开内容”直接进入隐藏分区，保留“已隐藏 · 直接打开”标记；新增、编辑和引用仍可用。主动勾选“显示”并保存才恢复普通目录。后续统一搜索应携带所属分区及 hidden 标记，打开结果不能隐式恢复目录。
- 同一本书的同一构思记录可在多个分区引用。内容、标题与图片都共用稳定记录和 contentId；编辑任一引用立即更新当前内存视图，保存后重开各处一致。跨作品记录或分区引用被拒绝，名称相同不合并。
- 分区设置有明确保存按钮，离开/关闭屏障也保存未完成的配置草稿；失败保留输入，允许改正、重试或主动撤回尚未保存修改。

## 持久化与兼容

主库 schema 从 3 升到 4，也兼容原有 1/2 升级路径。迁移及验证位于原 schema 事务内，不重建作品、正文或 contents，不删除未知列。失败回滚，测试核对原库字节不变。

| 数据 | 职责 |
| --- | --- |
| conception_records | 本书构思原记录：id、work_id、content_id、title |
| contents | 继续共用原有文字、图文格式和 revision |
| conception_references | 原记录在分区中的引用，引用不复制内容 |
| conception_sections | 每部作品独立的名称、显隐和顺序 |
| conception_work_state | 本书配置的乐观锁版本 |
| conception_defaults | 当前资料库未来新作品的候选组合与版本 |
| attachments | 继续以 contentId 管理、校验和读取图片 |
| recovery.sqlite3 / conception_snapshots | 与主库独立的构思恢复草稿，和正文 snapshots 分表 |

构思不会写入 chapters。现有正文目录、字数和正文导出选择器因此不会把构思混成章节。构思主库保存沿用完整格式/附件校验、revision 冲突拒绝与丢失回执的安全重试。前端只适配 EditorSession 的通用内容形状，未把构思存入正文表。

构思恢复沿用独立日志文件的身份检查、同步写入、完整性校验和序号保护。日志写入先于主库保存；主库失败仍可保留完整已落地草稿。进入本书构思时读取待核对草稿并提示，不自动覆盖。正文恢复列表和正文恢复命令不读取构思草稿。

无法确认先后的版本仅允许另存独立构思副本；复制仍归原作品，并尽量保留原引用分区（包括隐藏分区）。新副本有独立 contentId，图片文件与附件记录重新归属；复制事务失败清理临时副本文件、保留原内容和原日志。缺少或损坏图片时禁止把草稿当作完整内容应用。

## 前端接入契约

入口为 `src/conception/index.ts`，导出 `ConceptionController`、`ConceptionWorkspace`、`conceptionPort` 及独立 DTO。父组件稳定创建并持有控制器：

```tsx
const [conception] = useState(() => new ConceptionController(conceptionPort));
```

显示前先调用 `await conception.openWork(workId)`，成功后渲染：

```tsx
<ConceptionWorkspace
  controller={conception}
  disabled={busy}
  onReturn={() => void returnToWriting()}
/>
```

`onReturn` 只是请求父组件切换，父组件必须履行下列屏障；组件不会在卸载时启动保存。正文 session 可以保留挂起，构思使用同一机制的独立 session。

| 控制器接口 | 父组件使用方式 |
| --- | --- |
| flush(): Promise<boolean> | 等待正在进行的操作、图片、构思主库保存、当前书分区和默认值设置；false 时保持原界面 |
| isComposing(): boolean | 检查中文组合输入；不强迫候选字上屏 |
| preserveForRecovery(): Promise<boolean> | 主库冲突时保留当前完整输入后再进入恢复核对 |
| getSnapshot()/subscribe | 同步观察 editor、busy、error、设置草稿、恢复列表；editor 可接原 CloseReminder |
| reset(): void | 在成功切库后清除旧库记录、配置和恢复状态；忙碌、组合输入、dirty 或待保存时拒绝 |
| dispose(): void | 仅在已安全保存并最终退出时清理监听与计时器 |

必须逐条串行接入：

1. 当前 App 的 `settleInput`/action 屏障先等待 `conception.flush()`，再等待正文 session；失败不切换或卸载。切作品、书架、章节、API、资料库、返回正文、保存快捷键和正常窗口关闭都走相同屏障。
2. 正常关闭期间禁用编辑/操作；失败显示构思的 editor/error 状态并保留原界面。中文组合输入中拒绝关闭，不把候选输入保存为完成内容。图片导入任务由 session 追踪，关闭要等附件插入与保存回执。
3. 资料库切换在屏障完成后执行。`application.openLibrary` 成功才 `conception.reset()`；切库失败不 reset。切库操作前保持父级 busy，避免端口已切库而旧编辑器继续产生请求。reset 本身同步且要求 idle，不保留旧 contentId。
4. 退出构思不修改正文目录/正文 session，不把构思选为 library.workspace.chapter_id。书名下写作/构思入口由主会话整合，后续完整标签工作台另有任务。
5. App 全局恢复记录仍使用原正文接口；构思界面独立读取本作品构思草稿，防止误调用 recover_chapter。当前构思阅读位置未做跨重启恢复承诺。

构思 Editor 是现有富文本能力的本地包装版本，通过 port 注入图片读写。当前文件所有权限制下未修改 RichEditor。主会话可串行把可注入图片 port/编辑器 id 的公共实现提取出来，复用本目录组件回归测试以避免长期分叉。

## Tauri 命令注册契约

所有 DTO 使用 camelCase。下列命令尚须在 `src-tauri/src/lib.rs` 使用原 `access`/AppState 模式注册；表中参数对应 `src/conception/port.ts`：

| 命令及参数 | Library 方法 | 返回值 |
| --- | --- | --- |
| conception_view(workId) | conception_view(&work_id) | ConceptionView |
| conception_defaults() | conception_defaults() | ConceptionDefaults |
| change_conception_defaults(expectedRevision, sections) | change_conception_defaults(expected_revision, &sections) | ConceptionDefaults |
| change_conception_sections(workId, expectedRevision, sections) | change_conception_sections(&work_id, expected_revision, &sections) | ConceptionView |
| create_conception(workId, sectionId) | create_conception(&work_id, &section_id) | ConceptionRecord |
| reference_conception(workId, recordId, sectionId) | reference_conception(&work_id, &record_id, &section_id) | ConceptionView |
| save_conception(draft) | save_conception(&draft) | ConceptionRecord |
| checkpoint_conception(snapshot) | checkpoint_conception(&snapshot) | () |
| acknowledge_conception_recovery(sessionId, contentId, sequence) | acknowledge_conception_recovery(&session_id, &content_id, sequence) | () |
| list_conception_recovery(workId) | list_conception_recovery(&work_id) | Vec<ConceptionRecoveryCandidate> |
| recover_conception(id, sequence, asCopy) | recover_conception(&id, sequence, as_copy) | ConceptionRecord |

ConceptionSection、ConceptionDefaults、ConceptionView、ConceptionRecord、SaveConception、ConceptionRecoveryDraft 与 ConceptionRecoveryCandidate 已由 library.rs 导出。图片仍使用现有 import_image/read_image。Library::create_work 及正文恢复新作品事务会复制默认配置，无需父组件逐个创建分区。

## 后续契约与无虚假入口

本基线没有已落地的历史、统一搜索、回收站、日常备份或构思导出服务，本模块未添加可点击的假入口。后续接入必须包含：

- 历史：以 recordId/contentId 为身份留存标题和图文，恢复前保留当前内容，并列出共享引用的影响。
- 搜索：索引构思原记录一次，结果携带作品和引用位置，标记隐藏分区；打开不改变显隐。
- 回收站：区分移除引用与删除共用内容，删除前列出影响；当前模块没有删除记录操作。
- 备份/取回：保留上述当前有效表、分区状态、稳定引用和内容依赖图片；恢复日志属于异常恢复边界，不能把整库复制冒充日常过滤备份。构思导出不混入正文导出。
- 画布：后续直接引用同一记录/contentId，把布局、局部关系与文字内容分开；当前不宣称已实现画布。

## 当前证据

2026-10-17，独立 worktree，测试和构建经正常逐命令审批，以签入 Windows 用户环境运行。测试只用临时资料库和虚构受控内容；未访问真实用户资料库，未安装/启动 GUI。

- 构思 Rust 集成 7/7：即写/多处引用；显隐与重开；默认值只影响未来新书；跨作品拒绝；schema3 升级保留未知元数据及失败回滚；独立恢复与主库失败；图文冲突副本归属及失败清理；过期写入/序号/日志损坏/缺图保护。
- 构思前端受控检查 9/9：控制器关闭屏障和组件操作，包含中文组合事件、未保存设置、附件任务、隐藏内容直接打开/恢复入口、恢复全文末句与图片读取。jsdom 的 Range 几何用零矩形补齐，仅用于 DOM 行为，不是视觉证据。
- 全量前端 71/71，TypeScript 类型检查及 Vite 生产构建通过。构思尚未由 App 引用，生产构建不代表入口已接通。构建保留现有 Tiptap use-client/体积提示。
- 全量 Rust 40/40。未注册命令的构思 re-export 在隔离分支会产生 unused import 提示，主会话完成注册后复核。
- 未验证：主 App 全流程、真实 WebView2、Windows 中文输入法、实际窗口关闭、浏览器视觉和交互尺寸、深色主题/系统主题、异常进程终止、外部设计逐像素对齐及后续历史/搜索/回收站/备份集成。用户本轮禁止设计外发，已读 12ui skill 后按例外复用既有 A 的暖白、深灰与低饱和绿色，不运行外部设计服务。
