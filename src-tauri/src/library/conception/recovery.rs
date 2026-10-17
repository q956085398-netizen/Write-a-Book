use super::*;
use crate::library::recovery::checksum;
use std::{collections::HashMap, io::Write};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptionRecoveryDraft {
    pub session_id: String,
    pub sequence: i64,
    pub base: ConceptionRecord,
    pub draft: SaveConception,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptionRecoveryCandidate {
    pub id: String,
    pub sequence: i64,
    pub draft: SaveConception,
    pub base: ConceptionRecord,
    pub current: Option<ConceptionRecord>,
    pub conflict: bool,
    pub integrity_error: Option<String>,
}
fn same_base(current: &ConceptionRecord, base: &ConceptionRecord) -> bool {
    current.id == base.id
        && current.work_id == base.work_id
        && current.content_id == base.content_id
        && current.revision == base.revision
        && current.title == base.title
        && current.body == base.body
        && current.body_format == base.body_format
}
impl Library {
    pub(super) fn conception_journal(&self) -> Result<Connection> {
        let db = self.recovery_db()?;
        // A distinct table leaves existing chapter payloads and their recovery reader unchanged.
        db.execute_batch("CREATE TABLE IF NOT EXISTS conception_snapshots(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,content_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL,checksum TEXT NOT NULL,UNIQUE(session_id,content_id));").map_err(db_error)?;
        Ok(db)
    }
    pub fn checkpoint_conception(&self, snapshot: &ConceptionRecoveryDraft) -> Result<()> {
        if Uuid::parse_str(&snapshot.session_id).is_err()
            || snapshot.sequence < 1
            || snapshot.base.id != snapshot.draft.id
            || snapshot.base.content_id != snapshot.draft.content_id
            || snapshot.base.revision != snapshot.draft.expected_revision
        {
            return Err("构思恢复草稿身份或版本无效，原内容未修改。".into());
        }
        let actual = self.conception_record(&snapshot.draft.id)?;
        if actual.content_id != snapshot.draft.content_id || actual.work_id != snapshot.base.work_id
        {
            return Err("恢复草稿不属于此构思记录。".into());
        }
        self.validate_body(
            &snapshot.draft.body_format,
            &snapshot.draft.body,
            &snapshot.draft.content_id,
        )?;
        let payload = serde_json::to_string(snapshot).map_err(db_error)?;
        let mut db = self.conception_journal()?;
        let tx = db.transaction().map_err(db_error)?;
        let previous: Option<(i64,String)> = tx.query_row("SELECT sequence,payload FROM conception_snapshots WHERE session_id=? AND content_id=?",params![snapshot.session_id,snapshot.draft.content_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
        if previous.is_some_and(|(sequence, text)| {
            sequence > snapshot.sequence || (sequence == snapshot.sequence && text != payload)
        }) {
            return Err("构思恢复草稿顺序不一致，已有完整版本已保留。".into());
        }
        tx.execute("INSERT INTO conception_snapshots VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,content_id) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload,bytes=excluded.bytes,checksum=excluded.checksum",params![Uuid::new_v4().to_string(),snapshot.session_id,snapshot.draft.content_id,snapshot.sequence,payload,payload.len() as i64,checksum(payload.as_bytes())]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    fn conception_recovery_record(&self, id: &str) -> Result<ConceptionRecoveryDraft> {
        let db = self.conception_journal()?;
        let (payload, bytes, digest): (String, i64, String) = db
            .query_row(
                "SELECT payload,bytes,checksum FROM conception_snapshots WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(db_error)?;
        if bytes != payload.len() as i64 || checksum(payload.as_bytes()) != digest {
            return Err("构思恢复草稿校验失败，原文件已保留；不能将此记录当作完整内容。".into());
        }
        serde_json::from_str(&payload).map_err(db_error)
    }
    pub fn acknowledge_conception_recovery(
        &self,
        session: &str,
        content: &str,
        sequence: i64,
    ) -> Result<()> {
        if !self.root.join("recovery.sqlite3").exists() {
            return Ok(());
        }
        let db = self.conception_journal()?;
        let retained: Option<(String, i64)> = db
            .query_row(
                "SELECT id,sequence FROM conception_snapshots WHERE session_id=? AND content_id=?",
                params![session, content],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        if let Some((id, retained_sequence)) = retained {
            if retained_sequence <= sequence {
                let record = self.conception_recovery_record(&id)?;
                if self
                    .conception_record(&record.draft.id)
                    .is_ok_and(|c| same_conception(&c, &record.draft))
                {
                    db.execute(
                        "DELETE FROM conception_snapshots WHERE id=? AND sequence=?",
                        params![id, retained_sequence],
                    )
                    .map_err(db_error)?;
                }
            }
        }
        Ok(())
    }
    pub fn list_conception_recovery(
        &self,
        work_id: &str,
    ) -> Result<Vec<ConceptionRecoveryCandidate>> {
        if !self.root.join("recovery.sqlite3").exists() {
            return Ok(vec![]);
        }
        let db = self.conception_journal()?;
        let ids = {
            let mut query = db
                .prepare("SELECT id FROM conception_snapshots ORDER BY rowid")
                .map_err(db_error)?;
            let rows = query
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(db_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?
        };
        let mut result = vec![];
        for id in ids {
            let record = self.conception_recovery_record(&id)?;
            if record.base.work_id != work_id {
                continue;
            }
            let current = self.conception_record(&record.draft.id).ok();
            if current
                .as_ref()
                .is_some_and(|c| same_conception(c, &record.draft))
            {
                continue;
            }
            let integrity_error = self
                .validate_body(
                    &record.draft.body_format,
                    &record.draft.body,
                    &record.draft.content_id,
                )
                .err();
            let conflict = !current.as_ref().is_some_and(|c| same_base(c, &record.base));
            result.push(ConceptionRecoveryCandidate {
                id,
                sequence: record.sequence,
                draft: record.draft,
                base: record.base,
                current,
                conflict,
                integrity_error,
            });
        }
        Ok(result)
    }
    pub fn recover_conception(
        &mut self,
        id: &str,
        sequence: i64,
        as_copy: bool,
    ) -> Result<ConceptionRecord> {
        let record = self.conception_recovery_record(id)?;
        if sequence != record.sequence {
            return Err("此构思草稿在预览后已有更新。两份内容均保留，请刷新后核对。".into());
        }
        self.validate_body(
            &record.draft.body_format,
            &record.draft.body,
            &record.draft.content_id,
        )?;
        let saved = if as_copy {
            self.copy_conception_recovery(&record)?
        } else {
            let current = self.conception_record(&record.draft.id)?;
            if !same_base(&current, &record.base) {
                return Err(
                    "当前构思版本已变化，无法确认先后。两份内容均保留，请另存构思副本。".into(),
                );
            }
            self.save_conception(&record.draft)?
        };
        // Clear only the reviewed version after a complete main database commit.
        if let Ok(db) = self.conception_journal() {
            let _ = db.execute(
                "DELETE FROM conception_snapshots WHERE id=? AND sequence=?",
                params![id, sequence],
            );
        }
        Ok(saved)
    }
    fn copy_conception_recovery(
        &mut self,
        record: &ConceptionRecoveryDraft,
    ) -> Result<ConceptionRecord> {
        let content_id = Uuid::new_v4().to_string();
        let record_id = Uuid::new_v4().to_string();
        let mut files = PendingFiles::default();
        let mut attachments = vec![];
        let mut body = record.draft.body.clone();
        if record.draft.body_format == "wab-rich-v1" {
            let mut document: serde_json::Value = serde_json::from_str(&body).map_err(db_error)?;
            let mut remapped = HashMap::new();
            copy_images(
                self,
                &mut document["doc"],
                &record.draft.content_id,
                &mut attachments,
                &mut files,
                &mut remapped,
            )?;
            body = serde_json::to_string(&document).map_err(db_error)?;
        }
        let tx = self.db.transaction().map_err(db_error)?;
        let work = &record.base.work_id;
        // Reuse the original section, even if hidden. Opening a recovered record never unhides it.
        let section: Option<String> = tx.query_row("SELECT s.id FROM conception_sections s LEFT JOIN conception_references x ON x.section_id=s.id AND x.record_id=? WHERE s.work_id=? ORDER BY (x.id IS NULL),s.position LIMIT 1",params![record.base.id,work],|r|r.get(0)).optional().map_err(db_error)?;
        let section = match section {
            Some(section) => section,
            None => {
                let section = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO conception_sections VALUES(?,?,'恢复记录',0,0)",
                    params![section, work],
                )
                .map_err(db_error)?;
                tx.execute(
                    "UPDATE conception_work_state SET revision=revision+1 WHERE work_id=?",
                    [work],
                )
                .map_err(db_error)?;
                section
            }
        };
        tx.execute(
            "INSERT INTO contents(id,body,body_format,revision) VALUES(?,?,?,0)",
            params![content_id, body, record.draft.body_format],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO conception_records VALUES(?,?,?,?)",
            params![
                record_id,
                work,
                content_id,
                format!("恢复副本 · {}", record.draft.title)
            ],
        )
        .map_err(db_error)?;
        insert_reference(&tx, &record_id, &section)?;
        for (id, name, mime, size) in attachments {
            tx.execute(
                "INSERT INTO attachments VALUES(?,?,?,?,?)",
                params![id, content_id, name, mime, size],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        files.0.clear();
        self.conception_record(&record_id)
    }
}
#[derive(Default)]
struct PendingFiles(Vec<PathBuf>);
impl Drop for PendingFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}
fn copy_images(
    library: &Library,
    node: &mut serde_json::Value,
    source: &str,
    copies: &mut Vec<(String, String, String, i64)>,
    files: &mut PendingFiles,
    remapped: &mut HashMap<String, String>,
) -> Result<()> {
    if node["type"] == "managedImage" {
        let old = node["attrs"]["attachmentId"]
            .as_str()
            .ok_or("图片身份缺失。")?
            .to_string();
        let new = if let Some(id) = remapped.get(&old) {
            id.clone()
        } else {
            let (path, mime, size) = library.attachment_file(source, &old)?;
            let name: String = library
                .db
                .query_row("SELECT name FROM attachments WHERE id=?", [&old], |r| {
                    r.get(0)
                })
                .map_err(db_error)?;
            let bytes = fs::read(path).map_err(db_error)?;
            if bytes.len() != size {
                return Err("图片读取不完整，恢复尚未应用。".into());
            }
            let id = Uuid::new_v4().to_string();
            let path = library.attachment_dir()?.join(&id);
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(db_error)?;
            files.0.push(path);
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(db_error)?;
            copies.push((id.clone(), name, mime, size as i64));
            remapped.insert(old, id.clone());
            id
        };
        node["attrs"]["attachmentId"] = new.into();
    }
    if let Some(children) = node.get_mut("content").and_then(|n| n.as_array_mut()) {
        for child in children {
            copy_images(library, child, source, copies, files, remapped)?;
        }
    }
    Ok(())
}
