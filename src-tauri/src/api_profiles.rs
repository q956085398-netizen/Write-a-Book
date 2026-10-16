//! Application-wide API profiles. Only explicit connection tests can perform I/O over HTTP.
use reqwest::{blocking::Client, redirect::Policy, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};
#[path = "api_profiles/protection.rs"]
mod protection;

pub type Result<T> = std::result::Result<T, String>;
const STORAGE_ERROR: &str = "API 配置未保存，请检查本地存储权限或空间后重试。";
const SECRET_ERROR: &str = "无法安全读取或保存密钥，请在本机重新填写密钥后重试。";
pub const TEST_MESSAGE: &str = "Reply with OK.";
const MAX_RESPONSE: u64 = 65_536;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfile {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub model: String,
    pub is_default: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    #[serde(flatten)]
    pub profile: PublicProfile,
    pub has_key: bool,
}
// Never derive Debug or Serialize for a draft containing a secret.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDraft {
    pub id: Option<String>,
    pub name: String,
    pub endpoint: String,
    pub model: String,
    pub is_default: bool,
    pub key: Option<String>,
}
impl Drop for ProfileDraft {
    fn drop(&mut self) {
        if let Some(key) = &mut self.key {
            key.zeroize();
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfilesBackup {
    pub format: String,
    pub profiles: Vec<PublicProfile>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub message: String,
}

pub struct ApiProfiles {
    database: Connection,
    secrets: PathBuf,
}
impl ApiProfiles {
    pub fn open(config: &Path) -> Result<Self> {
        fs::create_dir_all(config).map_err(|_| STORAGE_ERROR)?;
        let database =
            Connection::open(config.join("api-profiles.sqlite3")).map_err(|_| STORAGE_ERROR)?;
        database.execute_batch("PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS api_profiles (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                endpoint TEXT NOT NULL, model TEXT NOT NULL, is_default INTEGER NOT NULL,
                key_ref TEXT NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS one_default_api ON api_profiles(is_default) WHERE is_default = 1;")
            .map_err(|_| STORAGE_ERROR)?;
        Ok(Self {
            database,
            secrets: config.join("api-secrets"),
        })
    }
    pub fn list(&self) -> Result<Vec<ProfileView>> {
        let mut statement = self
            .database
            .prepare(
                "SELECT id,name,endpoint,model,is_default,key_ref FROM api_profiles ORDER BY rowid",
            )
            .map_err(|_| STORAGE_ERROR)?;
        let rows = statement
            .query_map([], |row| {
                Ok(ProfileView {
                    profile: PublicProfile {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        endpoint: row.get(2)?,
                        model: row.get(3)?,
                        is_default: row.get(4)?,
                    },
                    has_key: !row.get::<_, String>(5)?.is_empty(),
                })
            })
            .map_err(|_| STORAGE_ERROR)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| STORAGE_ERROR.into())
    }
    /// Backup integration must use this DTO; never recursively copy app configuration.
    pub fn export_public(&self) -> Result<PublicProfilesBackup> {
        Ok(PublicProfilesBackup {
            format: "write-a-book.api-profiles.v1".into(),
            profiles: self.list()?.into_iter().map(|p| p.profile).collect(),
        })
    }
    fn existing(&self, id: &str) -> Result<(String, String)> {
        self.database
            .query_row(
                "SELECT endpoint,key_ref FROM api_profiles WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| STORAGE_ERROR)?
            .ok_or_else(|| "这套配置已不存在，请重新打开设置。".into())
    }
    fn secret_path(&self, reference: &str) -> Result<PathBuf> {
        Uuid::parse_str(reference).map_err(|_| SECRET_ERROR)?;
        Ok(self.secrets.join(reference))
    }
    fn read_key(&self, reference: &str) -> Result<Zeroizing<String>> {
        let path = self.secret_path(reference)?;
        let file = fs::File::open(path).map_err(|_| SECRET_ERROR)?;
        let mut encrypted = Vec::new();
        file.take(16_385)
            .read_to_end(&mut encrypted)
            .map_err(|_| SECRET_ERROR)?;
        if encrypted.len() > 16_384 {
            return Err(SECRET_ERROR.into());
        }
        let bytes = protection::unprotect(&encrypted)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| SECRET_ERROR)?;
        Ok(Zeroizing::new(text.to_owned()))
    }
    fn write_key(&self, key: &str) -> Result<String> {
        let encrypted = protection::protect(key.as_bytes())?;
        fs::create_dir_all(&self.secrets).map_err(|_| SECRET_ERROR)?;
        let reference = Uuid::new_v4().to_string();
        let path = self.secret_path(&reference)?;
        let result = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            file.write_all(&encrypted)?;
            file.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(path);
            return Err(SECRET_ERROR.into());
        }
        Ok(reference)
    }
    pub fn save(&mut self, draft: &ProfileDraft) -> Result<Vec<ProfileView>> {
        let endpoint = validate(draft)?;
        let old = draft
            .id
            .as_deref()
            .map(|id| self.existing(id))
            .transpose()?;
        if draft.key.is_none()
            && old
                .as_ref()
                .is_some_and(|(url, _)| url != endpoint.as_str())
        {
            return Err("地址已改变，请重新填写密钥，避免把原密钥发往新地址。".into());
        }
        let count: i64 = self
            .database
            .query_row("SELECT count(*) FROM api_profiles", [], |r| r.get(0))
            .map_err(|_| STORAGE_ERROR)?;
        let default = draft.is_default || count == 0;
        let id = draft
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        // Encrypt and sync a new immutable secret before committing its reference. Failure preserves the old pair.
        let new_reference = draft
            .key
            .as_deref()
            .map(|key| self.write_key(key))
            .transpose()?;
        let reference = new_reference
            .as_deref()
            .or_else(|| old.as_ref().map(|(_, key)| key.as_str()))
            .ok_or(SECRET_ERROR)?;
        let result = (|| -> Result<()> {
            let tx = self.database.transaction().map_err(|_| STORAGE_ERROR)?;
            if default {
                tx.execute("UPDATE api_profiles SET is_default=0", [])
                    .map_err(|_| STORAGE_ERROR)?;
            }
            tx.execute("INSERT INTO api_profiles (id,name,endpoint,model,is_default,key_ref) VALUES (?1,?2,?3,?4,?5,?6)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name,endpoint=excluded.endpoint,model=excluded.model,
                is_default=CASE WHEN excluded.is_default=1 THEN 1 ELSE api_profiles.is_default END,key_ref=excluded.key_ref",
                params![id,draft.name.trim(),endpoint.as_str(),draft.model.trim(),default,reference]).map_err(|_| "API 配置未保存，请检查名称是否重复及本地存储是否可写。")?;
            tx.commit().map_err(|_| STORAGE_ERROR)?;
            Ok(())
        })();
        if result.is_err() {
            if let Some(reference) = new_reference {
                if let Ok(path) = self.secret_path(&reference) {
                    let _ = fs::remove_file(path);
                }
            }
            return result.map(|_| Vec::new());
        }
        // Old encrypted material can be left behind by a crash; it is never enumerated or backed up.
        if new_reference.is_some() {
            if let Some((_, old_ref)) = old {
                if let Ok(path) = self.secret_path(&old_ref) {
                    let _ = fs::remove_file(path);
                }
            }
        }
        self.list()
    }
    pub fn prepare_test(&self, draft: &ProfileDraft) -> Result<PreparedTest> {
        let endpoint = validate(draft)?;
        let key = if let Some(key) = &draft.key {
            Zeroizing::new(key.clone())
        } else {
            let (saved_endpoint, reference) =
                self.existing(draft.id.as_deref().ok_or("请填写密钥。")?)?;
            if endpoint.as_str() != saved_endpoint {
                return Err("地址已改变，请重新填写密钥，避免把原密钥发往新地址。".into());
            }
            self.read_key(&reference)?
        };
        Ok(PreparedTest {
            endpoint,
            model: draft.model.trim().into(),
            key,
        })
    }
}
fn validate(draft: &ProfileDraft) -> Result<Url> {
    if draft.name.trim().is_empty() || draft.name.chars().count() > 80 {
        return Err("请输入 1–80 字的接口名称。".into());
    }
    if draft.model.trim().is_empty()
        || draft.model.len() > 200
        || draft.model.chars().any(char::is_control)
    {
        return Err("请输入有效的模型名称（最多 200 字节）。".into());
    }
    if draft.endpoint.len() > 2048 {
        return Err("接口地址过长。".into());
    }
    let url =
        Url::parse(draft.endpoint.trim()).map_err(|_| "请输入完整的 Chat Completions 地址。")?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "地址须使用 HTTPS（本机测试可用 HTTP），且不能含账号、密钥、查询参数或片段。".into(),
        );
    }
    if let Some(key) = &draft.key {
        if key.is_empty() || key.len() > 4096 || key.bytes().any(|c| !(33..=126).contains(&c)) {
            return Err("请填写有效密钥，不能含空白或控制字符。".into());
        }
    }
    Ok(url)
}

pub struct PreparedTest {
    endpoint: Url,
    model: String,
    key: Zeroizing<String>,
}
impl PreparedTest {
    pub fn execute(self) -> Result<ConnectionReport> {
        self.execute_with_timeout(Duration::from_secs(20))
    }
    fn execute_with_timeout(self, timeout: Duration) -> Result<ConnectionReport> {
        // Use reqwest's environment/system proxy support; HTTPS verification stays enabled.
        let builder = Client::builder()
            .redirect(Policy::none())
            .retry(reqwest::retry::never())
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(8));
        let builder = if self.endpoint.scheme() == "http" {
            builder.no_proxy()
        } else {
            builder
        };
        let client = builder
            .build()
            .map_err(|_| "无法建立连接测试，请检查系统网络配置。")?;
        let mut auth =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.key.as_str()))
                .map_err(|_| "密钥格式不正确。")?;
        auth.set_sensitive(true);
        let response = client.post(self.endpoint).timeout(timeout).header(reqwest::header::AUTHORIZATION, auth)
            .json(&serde_json::json!({ "model": self.model, "messages": [{"role":"user","content": TEST_MESSAGE}], "max_completion_tokens": 16, "stream": false, "store": false }))
            .send().map_err(|e| if e.is_timeout() { "连接测试超时，填写项已保留。" } else { "连接失败，请检查地址、网络、代理及证书。填写项已保留。" })?;
        let status = response.status();
        if status.is_redirection() {
            return Err("服务要求跳转，已停止；请核对并直接填写最终地址。".into());
        }
        if !status.is_success() {
            // Do not echo remote error bodies/headers/URLs: services may reflect Authorization.
            let reason = match status.as_u16() {
                401 | 403 => "密钥或访问权限未通过",
                404 => "未找到接口，请核对完整地址和模型",
                429 => "请求受限，请检查额度或稍后重试",
                _ => "服务未完成请求",
            };
            return Err(format!(
                "{reason}（HTTP {}）。填写项已保留。",
                status.as_u16()
            ));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "响应未完整接收，填写项已保留。")?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err("响应超过连接测试大小限制。".into());
        }
        let body: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "服务返回了非 JSON 响应，未确认协议兼容。")?;
        if body
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .is_none_or(|s| s.trim().is_empty())
        {
            return Err("服务响应不含文本回答，未确认此模型可用于文本问答。".into());
        }
        Ok(ConnectionReport {
            message: "连接测试成功：已收到文本回答。仅发送固定测试句，未发送作品。".into(),
        })
    }
}

pub struct ApiProfileState {
    config: PathBuf,
    profiles: Mutex<Option<ApiProfiles>>,
}
impl ApiProfileState {
    /// Lazy initialization prevents optional API settings failures from blocking offline writing.
    pub fn new(config: PathBuf) -> Self {
        Self {
            config,
            profiles: Mutex::new(None),
        }
    }
    fn access<T>(&self, action: impl FnOnce(&mut ApiProfiles) -> Result<T>) -> Result<T> {
        let mut guard = self.profiles.lock().map_err(|_| STORAGE_ERROR)?;
        if guard.is_none() {
            *guard = Some(ApiProfiles::open(&self.config)?);
        }
        action(guard.as_mut().ok_or(STORAGE_ERROR)?)
    }
}
#[tauri::command]
pub fn api_list_profiles(state: tauri::State<ApiProfileState>) -> Result<Vec<ProfileView>> {
    state.access(|profiles| profiles.list())
}
#[tauri::command]
pub fn api_save_profile(
    draft: ProfileDraft,
    state: tauri::State<ApiProfileState>,
) -> Result<Vec<ProfileView>> {
    state.access(|profiles| profiles.save(&draft))
}
#[tauri::command]
pub async fn api_test_connection(
    draft: ProfileDraft,
    state: tauri::State<'_, ApiProfileState>,
) -> Result<ConnectionReport> {
    let prepared = state.access(|profiles| profiles.prepare_test(&draft))?;
    tauri::async_runtime::spawn_blocking(move || prepared.execute())
        .await
        .map_err(|_| "连接测试未完成，请重试。")?
}
#[cfg(test)]
#[path = "api_profiles/tests.rs"]
mod tests;
