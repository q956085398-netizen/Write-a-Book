# T44：按目录范围导出书稿

Issue：#45。此模块提供独立后台行为、Port、选择面板与受控检查；共享入口由主会话串行注册。核心导出全程本地，不调用模型、网络转换或外部设计服务。

主会话已完成共享入口注册、原生 Word/TXT 导出及不覆盖检查，并在本机浏览器实际打开文件。后文证据为独立代理交付时的范围；整合证据和 Microsoft Word 实际显示尚未验证的限制见 [本批整合记录](t08-t44-t46-integration.md)。#45 保持开放等待文档阅读器复核。

## 范围与内容身份

- `manuscript_manifest(workId)` 在读事务内取得目录版本与正文身份。根目录的卷和未分卷章节按真实 position 混排；卷内章按自己的 position 排列。不会将全部章节简单按全局 position 排序。
- 支持当前章、选定章和全书。选定章的点击顺序不改变书稿顺序；只输出选中章节涉及的卷名，空卷不输出。同名卷通过 volumeId 区分。
- 未编章片段从来不自动加入。作者必须勾选并指定“某选中章之前”或“本次书稿末尾”；同锚点按面板片段列表顺序。章前片段输出在对应卷内，末尾片段不编入原目录。当前打开片段时“当前章”禁用，后台也拒绝把片段当当前章。
- 只通过当前作品 `chapters` 中 kind=chapter/fragment 的 identity 读取正文；构思、随记、参考及其他未入选内容不加入。编章仍保留同一 contentId，不复制或改写原稿。
- `ExportRequest` 不接受客户端正文或附件路径。后台验证 workId、entryId、contentId、kind、所选锚点及 expectedStructureRevision；过期目录拒绝，要求重新读取。面板的“重新读取目录”会清空章节选项、片段锚点与旧成功回执。

## 快照与保存边界

打开面板前和确认导出前都应等待当前 EditorSession 保存屏障。`beforeExport: () => Promise<void>` 必须在 `flush()` 返回 false 时抛错；不要只 await 一个返回 false 的调用。

后台从单 SQLite 读事务固定作品、目录版本、正文版本、rich JSON 和受管附件字节，之后只用内存快照构造文件。每张图片即使已经读取，也重新校验它属于当前 contentId；受管附件读取复用 `attachment_file(contentId,id)` 的路径、大小、边界与符号链接保护，并作有界读取与受限解码。回执记录 structureRevision 与各 contentRevision。读取/渲染失败不触碰目标文件。

导出不改正文、目录或附件，没有新增内容需要历史/搜索/恢复草稿登记；历史、回收站与备份仍由所属存储能力管理，导出文件不是资料库备份。

## 格式与文件提交

Word 使用标准 ZIP32 stored package 与 OOXML，不增加依赖。支持当前编辑器的段落、H1–H3、粗体、斜体、下划线、换行、链接、引用、无序/有序列表（含起始编号与嵌套缩进）、受管图片。PNG/JPEG/GIF 保留原图片字节；WebP 在本地受限解码后转 PNG，只改变导出表示。未知节点、属性、标记、版本、结构、危险链接或缺失/损坏图片明确报错，不靠丢弃格式完成导出。

TXT 是带 BOM 的 UTF-8 中文文本，以卷名、章名和段落顺序输出。文字样式、图片、链接目标与列表编号样式不保留；面板必须先显示说明并由作者勾选确认，后台同样验证 acknowledgeTxtLoss。图片缺失仍失败，避免把不完整原稿伪装成完整成功。

目标必须是资料库外的绝对路径，扩展名匹配格式。拒绝符号链接/目录、NUL、Windows ADS 冒号、控制字符、设备文件名和末尾点/空格；元数据读取失败除 NotFound 外均拒绝。NUL 在 Win32 FFI 转换前验证，防止路径截断改写意外已有文件。

先完整生成字节，再在目标同目录 `create_new` 临时文件，write/flush/sync。Windows 默认使用 `MoveFileExW(WRITE_THROUGH)` 同目录原子提交；目标已存在会失败，已有字节不变。只有明确允许替换时才加入 `REPLACE_EXISTING`，因此 Windows 导出无需 hard-link 文件系统支持。其他平台不覆盖模式使用同目录 hard_link、替换模式使用同目录 rename；不支持 hard links 时明确失败。失败清理临时文件；受控 Windows 文件锁失败已验证原文件保持完整。

面板只在收到真实写入回执后显示“书稿已写入文件”，给出实际路径、范围和字节数，并请作者用外部阅读器核对。不把包结构检查称为 Word 可视验收。

## 串行集成建议

在 `src-tauri/src/library.rs` 增加：

```rust
pub mod manuscript_export;
```

在 `src-tauri/src/lib.rs` 增加导入与命令，并将两个命令加入现有 generate_handler：

```rust
use library::manuscript_export::{ExportManifest, ExportReceipt, ExportRequest};

#[tauri::command]
fn manuscript_manifest(work_id: String, state: tauri::State<AppState>) -> library::Result<ExportManifest> {
    access(&state, |a| a.library()?.manuscript_manifest(&work_id))
}
#[tauri::command]
fn export_manuscript(request: ExportRequest, state: tauri::State<AppState>) -> library::Result<ExportReceipt> {
    access(&state, |a| a.library()?.export_manuscript(&request))
}
```

在 `src-tauri/capabilities/main.json` 现有权限中添加精确 `dialog:allow-save`，供文件保存选择器使用。

前端导入 `ManuscriptExport` 与 `nativeExportPort`，在已保存当前稿后打开：

```tsx
<ManuscriptExport
  workId={chapter.workId}
  currentEntryId={chapter.id}
  port={nativeExportPort}
  beforeExport={async () => {
    if (!(await session.flush())) throw new Error('当前输入尚未保存，请先处理保存提示。');
  }}
  onActivityChange={busy => { exportBusyRef.current = busy; }}
  onClose={() => setExportOpen(false)}
/>
```

父组件必须在面板活动期间保留挂载和当前资料库身份，并在原生 close 回调检查同步 exportBusyRef，阻止写入中销毁；不要只依赖延后的 React state/effect。面板选择文件、读取目录、保存屏障和导出期间同步回调 true，完成/失败回调 false；自身用 ref 阻止重复并发。目录刷新后不要悄悄保留失效选择。

## 当前证据

测试环境：签入 Windows 用户，逐命令 require_escalated。没有访问真实 AppData 资料库，没有安装软件、外发文件、操作 GUI、启动阅读器或终止进程。

- 独立 `.scratch/export-harness` 复制当时 library 源码并在副本注册新子模块：8 个导出 Rust 测试通过。覆盖目录次序、同名卷、反序选择、当前章、片段选择与位置、目录过期、无效范围、TXT 确认、未知 rich 数据、缺图/跨 contentId 图片、WebP、两图、已有文件不覆盖/原子替换、锁定目标保留、NUL/ADS/设备名路径回归。副本和 target 均不提交。
- `tsc --noEmit` 通过；独立 8 个 Vitest 用例通过，含失败无成功回执、保存屏障失败不调用导出、实际成功回执、当前片段禁用当前章、目录失败重读和锚点清空、同步活动回调。
- `verify-package.py` 用 Python 标准库 zipfile.testzip 独立验证 CRC/目录/各包条目，再解析所有 XML 与 relationships，核对中文、范围、顺序、编号定义顺序、格式标记、两张实际媒体和 TXT BOM。此检查不等于渲染。
- 首屏沿用已选 A 的色彩与布局语汇；已读 12ui skill，遵从本轮不外发例外，未运行外部设计对齐。浏览器、真实 Windows 面板、真实 Word/TXT 阅读器打开、重开应用操作验收由主会话补充，当前未验证。

持续样例在独立 worktree 的 `.scratch/export-fixtures/`（不提交）：

| 文件 | 应观察到的内容 |
| --- | --- |
| 全书图文.docx | 同名卷甲的开篇章（中文标题/粗斜下划线/链接/引用/起始3编号/嵌套项目/两图），同名卷乙的主动片段在中篇章之前，然后末章；未选片段不出现 |
| 全书图文.txt | 与全书相同正文次序；保留中文文字，不含两图与样式；未选片段不出现 |
| 选定两章.docx | 即使输入反向选中，开篇章仍先于中篇章；片段在中篇章之前；没有末章 |
| 当前章.docx | 只有中篇章与中文第二段及所属卷名，没有开篇章/片段/末章/图片 |

独立重查：`python src/manuscript-export/verify-package.py .scratch/export-fixtures`。Word 渲染与图片外观仍须真实阅读器核对。

OOXML 结构参考微软官方资料：[Inline](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.inline?view=openxml-3.0.1)、[Numbering](https://learn.microsoft.com/zh-cn/dotnet/api/documentformat.openxml.wordprocessing.numbering?view=openxml-3.0.1)。这里只用于包结构实现，不作为软件渲染通过的证据。
