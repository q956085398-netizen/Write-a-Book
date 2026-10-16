# T53：Windows 安装、升级与卸载保留资料

本项对应 Issue #54。安装包只包含构建时已落地的功能，当前分支基于 T01（新建作品、首章文字与本地保存）；富文本、图片、历史、搜索、回收站、备份及完整首版由各自任务接入。安装包生成不能作为完整首版或这些模块的验收结论，整合后的最终包须重测。

## 发行形式与资料边界

- Windows x64 NSIS 常规安装版，当前用户安装，不要求管理员权限。开始菜单“写一本书”可启动；交互式安装完成页的桌面快捷方式选项默认不勾选，可由作者选择。
- `productName=写一本书`、`identifier=net.writeabook.desktop` 保持稳定。默认程序位置为 `%LOCALAPPDATA%\写一本书`，可在向导中更改；安装器不选择、不复制、不迁移资料库。
- 资料库仍是作者选择目录中的 `library.sqlite3` 和 `attachments/`；首次启动提供“文档/写一本书资料库”或自选目录。请把资料库放在程序目录外。最近资料库位置保存在 `%APPDATA%\net.writeabook.desktop\settings.sqlite3`。更换安装目录不改变资料库身份或位置。
- 升级运行更高版本的安装程序，关闭正在运行的应用后继续。`allowDowngrades=false` 拒绝安装旧版本，避免在不兼容的数据格式上倒退；不要以覆盖文件的方式绕过。
- 卸载移除程序、卸载登记及快捷方式，保留资料库与应用配置。卸载器不提供数据清除选项。如作者确实要清除资料，须在退出应用、核对资料库实际路径和所需备份后，单独主动处理相应目录；本票不提供自动清除工具。
- 未配置代码签名或自动更新；当前测试包未签名。安装路径/升级保留验证与 Windows 信任提示验证分别记录。

## WebView2

`webviewInstallMode={type:downloadBootstrapper,silent:true}`。安装器检测已有 Evergreen WebView2 Runtime；缺少时下载并运行 Microsoft 引导程序，因此缺少运行时的首次安装需要联网。已装好运行时后的本地文字创作不依赖 AI 或账户。**离线使用不等于离线安装**；本发行形式不承诺离线安装。

本票不卸载、降级或移走系统共享 WebView2 来制造测试条件。本机已有运行时的检测与启动可以实测；无运行时下载、网络失败和完全离线安装须在独立干净 Windows 环境补测。官方依据：[Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)、[Windows 配置](https://v2.tauri.app/reference/config/#windowsconfig)。

## 构建与模板维护

```powershell
npm ci
npm run tauri -- build --bundles nsis
```

安装包位于 `src-tauri/target/release/bundle/nsis/写一本书_<version>_x64-setup.exe`。保持 Tauri 配置、Cargo 与 npm 的正式版本发布策略一致。用于本票升级验证的 `0.1.1` 只通过临时配置覆盖生成，未修改正式元数据，也不是正式发布。

```powershell
# 临时文件放在已忽略的 .scratch 中；不是正式版本变更。
New-Item -ItemType Directory -Force .scratch | Out-Null
'{"version":"0.1.1"}' | Set-Content .scratch/t53-upgrade.conf.json -Encoding utf8
npm run tauri -- build --bundles nsis --config .scratch/t53-upgrade.conf.json
```

自定义 `src-tauri/installer/installer.nsi` 来自 [Tauri CLI 2.12.3 官方模板](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)，上游原始文件 SHA-256 为 `8AE02C66F8ADB4A0D15D97F984FBACD2B44262D8A4D03FEFAF6177F67F7008E5`，MIT 许可保留在同目录 `LICENSE-MIT`。`upstream.patch` 是精确改动记录：增加来源注释、桌面选项默认不勾选、移除卸载数据删除复选框及对应删除块。没有修改运行时、版本比较、程序替换或开始菜单逻辑。

升级 CLI 时须重新对照该版本官方模板并重新执行安装/升级/卸载验证，不能让锁定模板静默落后于工具版本。

## 受控验证脚本

`scripts/t53-installer-check.ps1` 需要 PowerShell 7，真实安装及进程检查要在正常登录的 Windows 用户上下文，通过逐条具体命令审批执行。脚本仅接受此 checkout 的 `.scratch/t53-install-<32位小写十六进制>` 目录；拒绝联接/符号链接和未准备的测试范围，安装文件只能来自本 checkout 的 NSIS 构建输出。发现同名真实安装、入口或其他安装登记时停止，不覆盖它们，不结束任何运行中的应用，不递归删除目录。

每次真实桌面测试开始前，由主会话确认桌面空闲。`Prepare` 只新建测试目录，保存范围清单并复制已有 `settings.sqlite3` 为 `settings-before-test.sqlite3`；它不会修改原配置。测试会经 GUI 主动切换最近资料库，完成后由协调者核对副本并恢复原配置，或通过应用重新选择原资料库。不要将生产资料复制进本票测试范围。

```powershell
$root = Join-Path $PWD ('.scratch/t53-install-' + [guid]::NewGuid().ToString('N'))
./scripts/t53-installer-check.ps1 -Action Inspect
./scripts/t53-installer-check.ps1 -Action Prepare -TestRoot $root
./scripts/t53-installer-check.ps1 -Action Install -TestRoot $root -Installer (Join-Path $PWD 'src-tauri/target/release/bundle/nsis/写一本书_0.1.0_x64-setup.exe') -ExpectedVersion 0.1.0 -Interactive
# 在真实开始菜单启动安装版，选择 $root/library，创建作品并写入虚构中文，观察保存并正常退出。
./scripts/t53-installer-check.ps1 -Action Snapshot -TestRoot $root
./scripts/t53-installer-check.ps1 -Action Upgrade -TestRoot $root -Installer (Join-Path $PWD 'src-tauri/target/release/bundle/nsis/写一本书_0.1.1_x64-setup.exe') -ExpectedVersion 0.1.1 -Interactive
./scripts/t53-installer-check.ps1 -Action Verify -TestRoot $root
# 再次从开始菜单启动：同一作品、章节与全文可见且可继续编辑。正常退出。
./scripts/t53-installer-check.ps1 -Action Snapshot -TestRoot $root
./scripts/t53-installer-check.ps1 -Action Uninstall -TestRoot $root -ConfirmTestUninstall
./scripts/t53-installer-check.ps1 -Action Verify -TestRoot $root
# 重装升级版本，再从开始菜单启动，应自动找回同一资料库和已写文字。
```

`Snapshot/Verify` 对关闭状态下的资料库、附件文件与 `settings.sqlite3` 逐文件比较 SHA-256，并确认附件目录仍在。它证明安装动作前后的文件保留，不能代替 GUI 重开后观察正文。不要在应用打开、SQLite 尚在写入时取快照。当前 T01 尚无图片导入时可额外放入明确标记的附件目录保留探针；这只能证明目录内文件保留，不能称为已验证图片功能。

`Install/Upgrade` 不加 `-Interactive` 时使用静默安装；上游静默模式默认创建开始菜单和桌面快捷方式，桌面可选项的交互体验须另行观察。交互完成页如选择立即启动，须在后续 Snapshot/Upgrade/Uninstall 前正常关闭应用。

## 本次证据

环境：2026-10-16，本机正常登录的 Windows 用户 `NEWNAME\q9560`，Windows 11 专业版 `10.0.26300` x64，PowerShell `7.6.6`。managed worktree 位于默认可写根外，本票编辑、构建与检查使用逐条具体命令授权；未改变会话沙箱策略。Tauri CLI `2.12.3`，Rust Tauri `2.12.4`，NSIS `3.13`，NSIS Tauri Utils `0.5.3`。本机共享 Evergreen WebView2 注册版本 `155.0.4283.45`。

已完成的受控检查：

- 既有前端回归 2 个测试文件、8 项测试通过；TypeScript/Vite 生产构建通过。
- Release 构建与两个 NSIS 包生成成功。Cargo 的 lib/bin 调试符号文件名碰撞和链接器库创建提示未阻止构建。
- 保留原 `identifier` 和 CSP、仅 NSIS 发行、明确 WebView2 模式、模板无 AppData 删除代码的检查通过。
- 验证脚本通过 PowerShell 语法检查；实际拒绝磁盘根目录、非 GUID 测试目录、越界路径和未 Prepare 的卸载范围。未由这些负向检查执行安装或卸载。
- 首装前只读检查 HKCU、HKLM 和 32 位卸载表，以及默认程序目录、开始菜单、用户/公共桌面入口，未发现本应用安装。独立测试范围为 `.scratch/t53-install-5a193f2929274243b44e483a92d0fe48`；原有设置已复制保存，未读取或复制作者正文。

本次安装包（本地验证产物，不纳入 Git）：

| 版本 | 大小 | SHA-256 |
| --- | ---: | --- |
| 0.1.0 | 2,786,226 字节 | `9AACBD46978F3F64120C6B59B5B45E5BEF1DD9A8CD48AF1BDC596C33FC6CFC55` |
| 0.1.1 临时升级验证版 | 2,782,448 字节 | `0B8BEDC106502287ECE512866853A0D3F51A311717FCF98D1D1D879E491B1FD7` |

真实安装、升级、卸载及主会话 GUI 观察：首次安装向导已启动，等待协调者完成具体安装确认。以下仍未验证：安装完成后的开始菜单启动、桌面可选入口、升级前后正文与资料保留、卸载后重装找回、无 WebView2 运行时下载分支、离线安装、物理断网及整合后的完整首版流程。不把前述构建和静态检查计作这些项目通过。
