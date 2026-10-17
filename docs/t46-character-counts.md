# T46 字数（含标点）

计数单位沿用 `model.characterCount`：非空白 Unicode 码点，每个计 1，包含标点。英文逐字母计数，不按单词；中文每个汉字计 1。emoji 组合、组合附加符不合并为可见字形。前后端空白集合严格相同，采用 ECMAScript RegExp `\s`：U+0009–000D、0020、00A0、1680、2000–200A、2028、2029、202F、205F、3000、FEFF；U+0085、200B 仍计数。无 Unicode 规范化或 UTF-16 单元计数。

手工核对：`中文， A!` 为 5；加换行及 `🙂` 为 6。`👩‍💻` 是 3（女人、ZWJ、电脑）；`e` 加 U+0301 为 2。`片段🙂` 为 3。两章分别为 5 和 6 时全书章节为 11，独立片段为 3。章名、卷名、构思、本章/全书随记、图片及 alt 不计入；正文内部作者写的标题文本属于正文，照常计数。

## 集成契约

- 在 `library.rs` 声明 `mod character_counts; pub use character_counts::{WorkCharacterCounts, ContentCharacterCount};`。新增 `Library::character_counts(&self, work_id)` 返回 `{workId, structureRevision, contents:[{contentId,kind,revision,count}]}`，只读事务内读取。仅指定作品的 chapter/fragment，重复 contentId 拒绝统计；不遍历卷结构，重排与编章不会复制或重复统计。该模块无新依赖、无 schema 或资料写入。
- 主会话在 lib.rs 注册 Tauri 命令 `character_counts(workId)`，并用独立 `CharacterCountPort.characterCounts(workId)` 包装调用。无需修改公共 ApplicationPort 类型。
- `RichEditor` 新增可选 `onCharacterCountsChange`，报告 `{contentId,current,selection}`；卸载报告 null。无回调原有行为兼容；内部按 contentId 挂载，切换内容不会沿用前一文档。事务报告覆盖选择、编辑与撤销/重做；图片节点不会输出 alt。无效文档没有可用计数，应清除上一次 live。
- 将编辑器报告按 contentId 绑定当时会话的 revision，组成 LiveCharacterCount。传入当前作品 ID、structureRevision 和所有正文 contentId 的当前 revision 映射至 `deriveCharacterCounts`。此映射必须来自已确认的当前保存版本，未加载章节在结构/保存变更后用刷新快照重新建立。当前正文数量替换同 contentId 的保存值，只替换一次。
- 请求、作品/内容切换、保存或结构变更开始时 `CharacterCountLoader.invalidate()`；完成后刷新。loader 的 generation 阻止旧请求覆盖当前状态；组件卸载也 invalidate。新加载的完整快照才能建立 revision 映射，不能用旧快照为自己证明新鲜。结合独立会话/结构状态管理失效，不在 React render 中发请求。
- `CharacterCountFooter` 是现有页脚的普通文字扩展：传 counts、live、kind。聚合失败/过期时 counts=null，继续展示当前与选区实测值，只将全书章节和未编章片段标为暂不可用。live 必须属于当前 contentId，否则传 null。未知格式、解析错误不显示虚假 0。
- 字数与计时/净增/目标/写作记录无依赖，始终可用。它是正文派生值，不存第二份计数，不新增历史/搜索/附件/备份实体。恢复或重开后读取恢复后的真实正文再统计；后续各生命周期入口必须触发失效和刷新。

## 本次证据边界

独立 Vitest 使用 JSDOM 与 Tiptap，覆盖 Unicode、选区跨段落/图片、编辑撤销、未保存替换、过期/失败请求及原 RichEditor 兼容测试。独立 Rust harness 在忽略的 `.scratch/count-harness` 中只引入新模块、rusqlite/serde，使用临时 SQLite 测试查询范围、编章/重排、编辑回退及连接重开，不修改共享入口。

这是主会话集成前的独立模块验证，非真实 Windows 应用、中文输入法、原生 UI 或整库恢复验收。沿用已选 A 方向，不外发项目资料；12ui 外部视觉对齐未验证。主会话仍需接入命令、应用状态和页脚并完成真实操作/重开验收。
