# T02：中文图文编辑与资料库图片

本票接通正文图文编辑、保存和重开路径。正式编辑核心采用 Tiptap 3.32.0 / ProseMirror；Markdown 不是输入或保存格式的前提。段落、三级标题、粗体、斜体、下划线、有序/无序列表、引用、链接、图片、撤销和重做均有可见操作入口。禁用输入规则，避免输入普通符号时自动改变作者的文字结构。

## 内容与附件契约

- `Chapter` / `SaveChapter` 增加 `bodyFormat`。数据库 schema 2 的 `contents.body_format` 明确区分 `plain-text` 与 `wab-rich-v1`。从 schema 1 升级时，新增列、附件表和版本号在同一 SQLite 事务中提交。旧 `body`、revision 和稳定内容身份原样保留；仅打开或切换编辑状态不会自动改写正文。旧应用不支持 schema 2，需使用支持该版本的应用打开。
- 旧文本即使恰好是 JSON / HTML 也只按普通文字展示。实际编辑后才转为结构化格式。`wab-rich-v1` 的 body 为 `{ "format": "write-a-book", "version": 1, "doc": <ProseMirror JSON> }`；未知版本、节点或属性显示保留原文的只读错误入口，不把失败转换为空白。旧文本换行在首次编辑时成为段落；不承诺字节级导出还原 CRLF。
- `rich-content.ts` 负责格式边界、扩展集合和正文文字提取；`RichEditor` 负责编辑与组合事件；`EditorSession` 统一串行保存、revision 冲突和关闭/切换屏障。保存回执只推进 revision，不把服务器文本重新注入编辑器，因而不会重置光标与撤销栈。
- 其他正文、随记、拆书等模块后续使用相同内容 ID、格式和附件入口，不另造 HTML/临时图片路径格式。本票不增加这些尚未实现的模块。
- 图片通过 `import_image(contentId,name,bytes)` 传入作者选择/粘贴的文件字节，后端不接收任意源路径。校验 PNG、JPEG、GIF、WebP 的实际格式并解码，单文件上限 20 MiB、单边 12000 像素、解码分配上限 128 MiB。文件完整写入 `attachments/<UUID>` 并 sync 后才登记附件；登记失败返回错误并尝试移除未登记文件，不给出成功回执。
- 图片节点只存 `attachmentId` 和 `alt`。`read_image(contentId,id)` 校验规范 UUID、所属内容、数据库记录、受管目录/文件边界、长度与符号链接，再生成仅供显示的数据 URL。保存正文仅验证引用和文件元数据，不对每个图片重复构造 base64。源文件移动不会影响资料库副本。
- 图片粘贴、文件选择与文件拖入使用同一导入路径；导入期间暂时停用当前编辑器，关闭或切换会等待导入结束后补存。网页外链图不会直接载入；需复制图片本身或选本地文件。已管理图片在同一内容内复制粘贴保留附件身份。不同内容之间复制附件依赖后续显式复制/引用契约，当前不允许越过所属内容读取。
- 链接仅支持 HTTP、HTTPS 和 mailto；协议大小写不敏感，URL 其他字符原样保存。编辑区点击链接不触发外部导航。
- 图文保存沿用 T01 停输约 1 秒、连续输入约 5 秒、切换与正常关闭补存及失败保留草稿。组合输入期间不保存中间候选；结束事件之后取最终文档。图片不计入字数，文字按 Unicode code point 排除空白、包含标点。
- 为保持撤销可能引用的图片，本票不自动清理未引用附件。历史、搜索索引、回收站、备份与故障恢复尚未落地，必须在各自票中接入该契约；当前不显示这些能力已完成。正文结构化数据上限 16 MiB、层级上限 64，超限保留内存草稿并明确保存失败。

## 已执行检查与界限

2026-10-16，在原生 Windows 签入用户环境运行以下检查。专用 managed worktree 位于默认可写根外，因此使用正常逐命令审批；没有调整全局沙箱权限。

- `npm test`：15/15，通过。涵盖保存失败后重试、组合/连续输入调度、React 编辑区真实 DOM 组合事件（受控事件，不是真实输入法）、仅打开/切换禁用状态不改写旧正文、常用格式及图片身份往返、未知内容拒绝、内部图片复制和外部路径不进入文档。
- 长文受控样例：200 段、100000 个中文/标点字符、20 个图片节点，追加中文后持久化不改变选区，撤销/重做与重开结构一致。图片节点使用测试身份，未在该 jsdom 检查加载真实图片，也未测量真实窗口输入延迟。
- `cargo test --lib`：9/9，通过。使用真实临时 SQLite 与文件：创建/重开、稳定身份、revision 冲突、旧库迁移失败回滚且 JSON 外观旧正文原样保留、图片源移动后重开读回字节相同、未知/跨内容/目录穿越/缺失附件拒绝、附件登记失败不留成功记录、大小写协议的 URL 原样往返。
- `npm run build`：通过。Tiptap 的 use-client 指令与单个约 651 KB 的脚本包产生构建警告；本应用不使用服务端渲染，未把警告当作运行时验收通过的依据。
- 主会话在 main 集成后再次执行 `npm test`（15/15）、`npm run build` 和签入 Windows 用户环境的 `cargo test --lib`（9/9），均通过。沙箱中临时目录 rename 的两次 PermissionDenied 单独归为执行环境限制，不计为 Windows 原生产品失败。

## 真实 Windows 验收记录

2026-10-16，主会话在签入 Windows 用户环境使用原生 WebView2 应用完成以下操作，并在结束时正常退出应用、确认无窗口后停止电脑控制。本节依据主会话的实际操作与证据回报记录；不以 jsdom 或 Unicode 文本注入代替真实输入法。

测试应用为本票 `write-a-book.exe`，SHA-256：`5A105C71F4C255709BC203445B825E2C953B0A187330C8584AF108D65CBA35EF`。测试资料库来自 #54 的独立安装验证库，初始为 61 字旧纯文本；全部内容和图片均为测试资料。

1. 在编辑区以真实按键输入 `n i h a o`，观察到输入法组合串 `ni'hao` 和首候选“你好”；按空格仅提交一次“你好”。使用 Ctrl+Z / Ctrl+Y 撤销和重做；选中“你好”后点击粗体，选区保留且格式生效。
2. 使用原生文件选择导入 `source-image.png`（仓库图标的测试复制）。再用 Paint 打开 `clipboard-image.png`，Ctrl+A / Ctrl+C 复制图像，在编辑器 Ctrl+V 粘贴；两张受管理图片实际显示。
3. 用 Notepad GUI 打开 180 段虚构长文并复制粘贴到正文。样例包含 11052 个非空白 Unicode code point；加上原有文字和“你好”后计数 11115。在末尾续写 8 字“长文末尾继续写。”后计数 11123；撤销回 11115，重做回 11123。保存后光标仍在末尾。
4. 正常关闭应用后，将原始 `source-image.png` 改名为 `source-image-moved.png`，文件 SHA-256 保持不变。完成 #54 最终卸载测试安装后，再次打开本票应用：正文计数 11123，两张图片实际显示，“你好”的粗体仍保留。正文去除空白和对象占位符后与保存时全文逐字一致，计数同为 11123。

本地主会话证据位于 `.scratch/issue-batch-20261016/`：`editor-ime-composing.png`、`editor-long-saved.png`、`editor-long-saved.txt`、`editor-image-restored.png`、`editor-two-images-restored.png`。这些为本机验收工件，不随源码提交。

覆盖边界：真实输入法仅验证上述拼音样例和长文规模，未遍历所有输入法，也未进行输入延迟或内存性能测量。原生格式操作专门验证粗体；标题、斜体、下划线、列表、引用、链接等格式由自动测试验证。视觉复用已批准的 A 基线，没有新增向 12ui 外发资料或执行新的像素对齐检查。本票不宣称异常退出、物理断网、历史/备份或完整首版已验收。

## 依赖核对

npm registry 实时核对并精确锁定 `@tiptap/react`、`@tiptap/core`、`@tiptap/pm`、`@tiptap/starter-kit` 3.32.0，许可 MIT。Rust lockfile 锁定 image 0.25.10 与 base64 0.22.1，发布包元数据均为 MIT OR Apache-2.0。仅使用开源编辑核心与本地自建附件实现，没有付费扩展或云端服务依赖。

官方依据：[React 安装](https://tiptap.dev/docs/editor/getting-started/install/react)、[StarterKit](https://tiptap.dev/docs/editor/extensions/functionality/starterkit)、[JSON 持久化](https://tiptap.dev/docs/editor/core-concepts/persistence)、[MIT 许可](https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md)。编辑器适配源码核对了 `setEditable` 默认会发 update 事件，本项目显式关闭该事件，避免仅查看就迁移内容。
