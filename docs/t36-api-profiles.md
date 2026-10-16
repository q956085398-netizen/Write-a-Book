# T36 多套 API 配置与独立连接测试

## 支持边界

首个协议为 OpenAI Chat Completions 的非流式文本子集：作者填写完整 POST 地址（例如 `https://api.openai.com/v1/chat/completions`）、模型和 Bearer 密钥。不会自动拼接路径、拉取模型、探测能力、读取正文或建立 AI 会话。本实现不声明所有 OpenAI 风格服务、模型或代理兼容。`max_completion_tokens`、`store` 参数不被接受的第三方服务会如实报错，不悄悄降级或重试其他协议。单次短测试成功只证明该地址/模型接受此次请求并返回文本。

实际发送 JSON 恰为：

```json
{"model":"作者填写的模型","messages":[{"role":"user","content":"Reply with OK."}],"max_completion_tokens":16,"stream":false,"store":false}
```

不发送接口显示名称、作品/章节/附件、系统提示词或对话历史。密钥仅在 Authorization header 中发往作者填写的地址。保存、重开及切换配置均不请求服务；测试未保存的填写项也不会顺带保存。服务仍可能计费，界面在主动测试按钮旁明确说明。

允许 HTTPS，以及 localhost/loopback IP 的 HTTP 受控测试；拒绝 URL 账号密码、query、fragment，避免把密钥藏进可备份地址。所有 3xx 都停止，不跟随跨域或同域跳转；禁用库内协议自动重试。更换已保存配置的地址时必须重新填写密钥，避免自动带出旧密钥。TLS 校验启用；HTTPS 保留 reqwest 所支持的系统/环境代理，HTTP loopback 强制直连本机，未提供自定义代理 UI、PAC、企业证书或代理兼容承诺。

测试总超时 20 秒、连接超时 8 秒、响应正文最多读取 64 KiB + 1 个判界字节。错误只呈现固定分类和 HTTP 状态码，响应正文、响应 header、服务 URL、底层 HTTP 错误均不输出日志或 UI，避免反射密钥。成功也不展示服务返回的原文。HTTP 200 但非 JSON、无文本 choices、超量响应都不显示成功。

## 存储和备份契约

配置全应用共用，独立于资料库。`api-profiles.sqlite3` 保存名称、地址、模型、默认标记和内部密钥引用；前端列表仅多出 `hasKey` 布尔值，绝不读取原密钥。名称不区分 ASCII 大小写重复时拒绝保存。第一套自动成为默认，之后通过另一套的“设为默认”保存来切换；不会出现多个默认。

密钥附版本标识与内部 SHA256 校验后，通过 Windows 当前用户 DPAPI (`CryptProtectData` / `CryptUnprotectData`) 加密到同配置目录的 `api-secrets/`；禁用提示 UI，不使用 `CRYPTPROTECT_LOCAL_MACHINE`。SQLite、JSON、日志、前端持久存储中均不保存明文密钥。DPAPI 依赖本机 Windows 用户的保护材料，不承诺跨机或另一个用户可解密；换机须重新填写密钥。它不保护已经控制同一 Windows 用户会话的进程，也不承诺消除操作系统/网络库的全部内存副本。

更新先创建并 sync 新的不可变密文，再用 SQLite 事务切换配置引用，提交失败保留旧配置和密钥；旧密文在成功后删除。崩溃或删除权限失败可能留下未引用密文，应用不会枚举/导出它们。本期不做自动扫描清理，不操作 Credential Manager 里的其他凭据。

**备份接入必须调用 `ApiProfiles::export_public()`**，输出带版本格式标识的 `PublicProfilesBackup`，只含稳定 ID、名称、地址、模型和默认标记；排除 `key_ref`、`hasKey`、密文和密钥。不能把递归复制应用配置目录当作符合本契约的默认备份。完整备份/导入、历史、搜索、附件和回收站功能尚未落地，此模块提供公开备份 DTO，不冒充已经集成这些产品流程。公开配置取回之后需要重新输入密钥，后续备份任务须明确实现取回流程。

## 最小整合接线

此 Issue 独立模块先由 `src-tauri/tests/api_profiles_harness.rs` 导入并编译，避免共享 lib.rs 并行编辑；主会话串行接入时：

1. `src-tauri/src/lib.rs` 声明 `mod api_profiles;`，导入 `ApiProfileState`, `api_list_profiles`, `api_save_profile`, `api_test_connection`。
2. setup 已有 `config` 后，以 `app.manage(ApiProfileState::new(config.clone()))` 注册。构造不做存储 I/O；首次打开设置时才惰性打开，错误展示在 API 页，用户重试会再次初始化，不阻断离线写作。
3. 将三个 command 加入 `generate_handler!`。连接测试内部用 blocking worker，不持有数据库锁等待网络。
4. 前端 `api-profiles-api.ts` 已有独立 invoke 适配器和 `ApiProfilesPort`。`ApiSettingsController` 管理保存/测试独立状态、未保存填写、默认选择和防重入，既无作品读取端口也无自动请求；测试可注入假端口。组件接口/验证结果在组件完成后补充。

## 官方依据

- [OpenAI Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：messages/model、非流式文本结果、max_completion_tokens 与 store 参数（2026-10-16 检查）。
- [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) 和 [CryptUnprotectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)：当前用户保护、UI_FORBIDDEN、LocalFree 和内存清理（2026-10-16 检查）。
- reqwest 锁定为 0.12.28；本机下载的官方 crate `src/blocking/client.rs` 与 `src/async_impl/client.rs` 用于核对 redirect、timeout、proxy 默认行为。在线 [ClientBuilder 文档](https://docs.rs/reqwest/latest/reqwest/blocking/struct.ClientBuilder.html) 当前指向 0.13.5，不能据此声称本实现使用 0.13。

## 验证记录

2026-10-16 至 10-17，独立 worktree 使用签入 Windows 用户的逐命令审批环境，全部密钥均为明确命名的假值，存储均在测试临时目录；没有读取实际 AppData 配置或 Credential Manager。

- 完整 Rust 回归 19/19（既有资料库 9、API harness 10）；API 覆盖真实 DPAPI 重开、密文截断/篡改、密钥/配置保存失败保旧、公开备份排除、惰性初始化重试、固定 POST 内容比对、3xx/401/429/非 JSON/无文本结果、64 KiB 限制、连接超时和慢速持续响应截止时间。后续追加的 DPAPI 空输出防护经两项 DPAPI 测试复核通过。
- 前端端口及状态逻辑 8/8。组件布局尚待批准的 12ui 转换产物恢复后接入，不将状态测试当作完成 UI。
- 前端生产构建已过；保留既有 Tiptap use-client / 大脚本警告和 Cargo PDB 同名警告。独立 harness 中三个尚未接入主入口的 command 产生未调用警告，模块已实际编译和测试。
- 未使用真实服务凭据，真实服务联调未运行。受控端点/状态逻辑测试不等于真实 Windows WebView2 点击验收；原生窗口由主会话串行执行。
