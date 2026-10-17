# T08 / T44 / T46 本地整合与验收

2026-10-17，Issue #9、#45、#47。基线为已发布的 `c76dcc5`，本批尚未获得推送或关单授权。#6 已在上一批授权下发布关闭；#4 仍开放，原生输入法候选焦点保护尚未确认。本文区分独立模块检查、真实 Tauri/WebView2 操作和文件预览，未完成项不作为通过结论。

## 选择、模型与文件分工

刷新 GitHub 后，无阻塞且未分配的候选为 #9、#12、#13、#42、#45、#47。按依赖图先选择 #9，再选择文件边界可隔离的 #45、#47。#12/#13 涉及共用记录存储，#42 涉及目录/schema，暂缓以避免与 #9 同时修改同一文件。

| Issue | 复杂度、范围和风险 | 独立子代理 | 分支 / worktree 名 | 原提交 → main 提交 |
| --- | --- | --- | --- | --- |
| #9 自由构思 | 跨 schema、作品配置、共用引用、图文附件及异常恢复，耦合和失败风险高，需较深推理 | gpt-6.1-sol / xhigh | codex/issue-9-conception / issue-9-conception | 1c9b76a → 045c4b5 |
| #45 书稿导出 | 只读目录快照独立，但文档格式、图片完整性和原子写入风险较高 | gpt-6.1-sol / high | codex/issue-45-manuscript-export / issue-45-manuscript-export | 7c1b9c9 → b8a52e4 |
| #47 字数 | Unicode 与保存版本对齐，范围明确的常规开发，风险中等 | gpt-6.1-sol / medium | codex/issue-47-character-count / issue-47-character-count | d72537b → bc3993c |

每个代理只负责一个 Issue，自行读代码、测试并提交；工作目录均为对应 managed worktree 下的 Write-a-Book。#9 独占构思及 schema/恢复文件，#45 独占新导出模块，#47 独占计数模块与 RichEditor。代理没有并发修改相同文件。共享 App、命令入口、权限和样式均由主会话在代理完成后串行整合。没有为简单步骤无条件分配最高模型，也未中途降级顺利工作的代理。

实现文件可按三个代理提交分别查看。主会话额外修改 App.tsx、RichEditor.tsx、conception/Editor.tsx、manuscript-export/ManuscriptExport.tsx、styles.css、src-tauri/src/lib.rs、library.rs 和 capabilities/main.json；新增 useCharacterCounts.ts、App.counts.test.tsx、App.batch5.test.tsx，更新 README 与本批文档。未新增产品依赖。

## 整合行为

- 构思记录有独立 recordId/contentId，分区保存引用而非复制正文；隐藏不删除，设置可直接打开隐藏内容或恢复入口。当前作品配置和未来作品默认配置独立。schema 4 迁移保留旧正文、附件和未知元数据。
- 构思与正文共用图文编辑实现及图片任务屏障；主 App 在切换作品、模式、资料库、保存和关闭前处理两个会话，保存失败保留当前界面和草稿。构思快照位于独立恢复日志，成功保存后按会话与序号确认。
- 导出面板使用真实保存对话框及精确 dialog:allow-save 权限。先完成保存，再以目录和正文版本快照生成 Word/TXT；原生关闭在导出活动期间暂停，失败不显示成功。目标默认不覆盖，替换须明确选择。只导出章节与主动选择并指定位置的片段。
- 字数快照按资料库、作品、目录版本、正文保存版本和任务状态失效；旧响应不能覆盖新视图。当前未保存正文只替换同 contentId 的一个保存值。聚合读取失败仍保留当前正文/选区计数，全书和片段显示“暂不可用”。

## 自动检查与构建

主会话在本地 main、签入 Windows 用户的逐命令审批环境完成前端 88/88（18 文件）、Rust 51/51。前端含实际 App 的构思失败切换/关闭重试、导出 Promise 期间关闭阻止、实时编辑/撤销/选区字数，以及聚合失败降级检查。Rust 含 schema 迁移回滚、恢复冲突、引用/附件归属、计数范围、导出格式/目录过期、缺图、路径 NUL/ADS/设备名、已有文件保全与原子替换检查。受控检查不代替实际磁盘耗尽、断电或真人多窗口竞争。

TypeScript/Vite 构建、Rust 格式及差异检查通过；隔离标识原生 debug 与正式标识 release 构建通过，哈希见文末构建记录。保留既有 Tiptap use-client、大脚本、Cargo PDB 同名及公开备份 DTO dead-code 提示。本批没有生成或安装新安装包，不宣称已复测升级/卸载。

## 真实 Windows 操作

实际使用本机 Tauri/WebView2 debug EXE，配置窗口 1280×860，测试标识 net.writeabook.batch5test。仅使用虚构资料库 `.scratch/issue-batch-20261017b/native/synthetic-library`；没有启动正式应用配置。脚本准备旧库和受控故障，以下作者操作由原生界面完成。

1. 首次启动实际打开 schema 3 旧库并升级至 4。即时核对旧作品、章节、正文、版本、附件、分卷、继续位置逐行相等，额外字段/自定义表及原图片 SHA-256 保留，完整性和外键检查通过。
2. 在第一章输入 `中文，Ab 12😀`，含标点且非空白码点为 8。实际编辑、全选、撤销和重开核对；全选为 8，当前章为 8，全书两章为 25，独立片段 `片段，xyz` 为 6。构思文本、标题和图片没有计入全书值。
3. 直接新建自由构思“结局先写”，输入“先从结局的一种感受开始，不必先填人物表。”并用原生文件选择器导入 PNG。将图片源文件移动后，资料库图片仍可显示。把同一记录引用到“本书参考”，没有复制记录或正文。
4. 调整当前书分区顺序并隐藏“故事核心”。导航入口消失，设置直接打开仍可读取完整记录与图片且保留隐藏标记。修改未来新作品第一分区为“未来新书自选分区”，原作品分区名称不被改写。
5. 仅测试库加入拒绝该构思正文更新的触发器。通过界面把标题改为“结局先写·失败仍保留”，返回正文被阻止；正常关闭也暂停，完整标题、正文、图片身份保存在独立恢复日志。即时检查主库原版本和附件字节不变。移除测试触发器后，点击“重试保存并关闭”，程序正常退出。重开后修改后的标题、原正文和图片均保留，revision 为 4，恢复快照已确认清除。
6. 通过第二个引用打开同一记录，读取到相同新标题和图文。设置勾选显示“故事核心”并保存，原入口恢复且顺序保留。实际新建“默认值验收新书”，其首个分区采用“未来新书自选分区”；回到原作品仍为自身配置。最终数据库核对两个旧同名作品的分区也保持原候选。
7. 在真实导出面板选择全书、主动勾选未编章片段并指定书稿末尾，使用原生保存对话框导出“原生全书与片段.docx”。成功回执为 2 章、1 片段、1 张受管图片、12,008 字节。再次确认相同目标但不勾选替换，显示失败且无成功回执；文件 SHA-256 前后相等。
8. 切换 TXT，确认图片与样式损失后，导出“原生全书与片段.txt”，回执为 2 章、1 片段、156 字节。独立核对 UTF-8 BOM、中文及目录顺序，构思、参考和空卷没有混入。正常关闭、重开后正文及 8/25/6 字数一致，之后再次正常退出。

最终只读检查通过：旧资料行和图片保留；仅第一章预期编辑改变原正文；构思为 1 条原记录、2 个引用且 contentId 不变；分区恢复与未来默认值独立；异常恢复已确认；无测试故障触发器；正式 settings.sqlite3 和原有 38 个未跟踪文件 SHA-256 全部保持。未操作真实作品或 API 配置。

## 文件结构、预览与未验证项

使用 Python 标准库独立检查 ZIP CRC、每个 XML/relationship、媒体 SHA-256、中文、卷章/片段顺序与构思排除。代理复杂样例还覆盖粗体、斜体、下划线、链接、引用、起始编号 3、嵌套列表、两图及 WebP 转 PNG。当前章/选定章节范围和失败路径有自动检查；本次原生实际导出覆盖全书加主动片段。

原生生成的 Word/TXT 文件均在仅绑定 127.0.0.1 的本地浏览器查看器实际打开。docx-preview 的独立预览可见正确中文、顺序和图片；代理复杂样例也完成浏览器外观核对。这是独立 HTML 预览，不证明 Microsoft Word 分页或版式一致。标准 render_docx.py 因本机无 soffice.exe 未能渲染；已有 WPS 首页显示开启文档云同步，因此没有用 WPS 打开测试文件，没有更改其同步/隐私设置，也没有外发文件。

#9、#47 已达到本轮本地验收范围；#45 实现和上述检查完成，但保守保持开放，等待 Microsoft Word 或确认无外发的兼容阅读器实际核对复杂样例。#4 原生候选焦点问题继续开放。异常进程终止、断电、实际磁盘故障、深色/系统主题和最终整包验收未在本轮复测。

用户本轮明确“不外发；允许沿用 A 并注明未验证”，因此没有调用 12ui、上传设计上下文或截图。沿用已选 A；外部逐像素设计对齐未验证。未落地的历史、统一搜索、回收站和日常备份仅保留后续契约，不显示虚假入口；本批不缩减父规格其余首版范围。

本机证据保存在忽略目录 `.scratch/issue-batch-20261017b/native/`：startup-migration-verification.json、conception-before-failure.json、conception-retained-draft.json、final-verification.json；counts-selection-eight、hidden-section-direct-open、conception-close-paused、reopened-conception-reference、future-work-defaults、restored-core-and-independent-work、native-word-export-receipt、native-export-no-clobber、native-txt-export-receipt、native-word-browser-preview、final-reopen-counts 的截图/可访问树。虚构库检查脚本、样例、测试程序与图片不提交，不等同于 GUI 自动回归测试。

## 构建记录

实际验收程序另存 verified-batch5-test.exe，SHA-256：`EE46C0F1385C0EEF2B723D35E01F97B5EAB02DACFD166B14E334A5CFCD68E161`。正式标识 release EXE 构建成功，SHA-256：`C0169B38757E6720124431E0E36CFF78EEB299D3703207D6CAEC3579A453EBE9`；没有启动正式配置，不宣称 release GUI 已另测。

原生 Word 导出 SHA-256：`0AC26D1CF2D29173DA98C2748142DC0B4730A04CA4E28D7BDCC3B43A7B7DCC36`；TXT：`71193F2837CAF85FD59531B3F41F7FAB824A754CBE777F9559EE95409F475CD8`。防覆盖失败后 Word 哈希不变。
