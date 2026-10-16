use super::*;
use std::io::Write;

const RECOVERY_APPLICATION_ID: i64 = 0x57415231;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
    pub session_id: String,
    pub sequence: i64,
    pub base: Chapter,
    pub draft: SaveChapter,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    pub id: String,
    pub sequence: i64,
    pub draft: SaveChapter,
    pub base: Chapter,
    pub current: Option<Chapter>,
    pub conflict: bool,
    pub integrity_error: Option<String>,
}
// Accidental-corruption check, not an authenticity or hostile-tampering boundary.
fn checksum(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}
fn same_content(current: &Chapter, draft: &SaveChapter) -> bool {
    current.id == draft.id
        && current.content_id == draft.content_id
        && current.title == draft.title
        && current.body == draft.body
        && current.body_format == draft.body_format
}
fn same_base(current: &Chapter, base: &Chapter) -> bool {
    current.id == base.id
        && current.content_id == base.content_id
        && current.revision == base.revision
        && current.title == base.title
        && current.body == base.body
        && current.body_format == base.body_format
}
impl Library {
    fn recovery_db(&self) -> Result<Connection> {
        let path = self.root.join("recovery.sqlite3");
        let existed = path.exists();
        if existed
            && fs::symlink_metadata(&path)
                .map_err(db_error)?
                .file_type()
                .is_symlink()
        {
            return Err("恢复日志不能是链接文件，原文件未修改。".into());
        }
        let db = Connection::open(&path).map_err(db_error)?;
        db.busy_timeout(Duration::from_secs(2)).map_err(db_error)?;
        if existed {
            let app_id: i64 = db
                .query_row("PRAGMA application_id", [], |r| r.get(0))
                .map_err(db_error)?;
            let version: i64 = db
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(db_error)?;
            if app_id != RECOVERY_APPLICATION_ID || version != 1 {
                return Err("恢复日志格式无法确认，文件已保留；请勿删除或覆盖。".into());
            }
        }
        db.execute_batch("PRAGMA synchronous=FULL;")
            .map_err(db_error)?;
        if !existed {
            db.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE snapshots(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content_id TEXT NOT NULL,
                  sequence INTEGER NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, checksum TEXT NOT NULL,
                  UNIQUE(session_id,content_id));
                PRAGMA application_id=1463898673; PRAGMA user_version=1; COMMIT;").map_err(db_error)?;
        }
        let integrity: String = db
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(db_error)?;
        if integrity != "ok" {
            return Err("恢复日志完整性检查失败，文件已保留，不能确认其中的草稿。".into());
        }
        Ok(db)
    }
    pub fn checkpoint_chapter(&self, snapshot: &RecoveryDraft) -> Result<()> {
        if Uuid::parse_str(&snapshot.session_id).is_err()
            || snapshot.sequence < 1
            || snapshot.base.id != snapshot.draft.id
            || snapshot.base.content_id != snapshot.draft.content_id
            || snapshot.base.revision != snapshot.draft.expected_revision
        {
            return Err("恢复草稿身份或版本无效，原内容未修改。".into());
        }
        let actual = self.read_chapter(&snapshot.draft.id)?;
        if actual.content_id != snapshot.draft.content_id {
            return Err("恢复草稿不属于此章节。".into());
        }
        self.validate_body(
            &snapshot.draft.body_format,
            &snapshot.draft.body,
            &snapshot.draft.content_id,
        )?;
        let payload = serde_json::to_string(snapshot).map_err(db_error)?;
        let mut db = self.recovery_db()?;
        let tx = db.transaction().map_err(db_error)?;
        let prior: Option<(i64, String)> = tx
            .query_row(
                "SELECT sequence,payload FROM snapshots WHERE session_id=? AND content_id=?",
                params![snapshot.session_id, snapshot.draft.content_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        if let Some((sequence, previous)) = prior {
            if sequence > snapshot.sequence
                || (sequence == snapshot.sequence && previous != payload)
            {
                return Err("恢复草稿顺序不一致，已有完整版本已保留。".into());
            }
        }
        tx.execute("INSERT INTO snapshots VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,content_id) DO UPDATE SET
            sequence=excluded.sequence,payload=excluded.payload,bytes=excluded.bytes,checksum=excluded.checksum",
            params![Uuid::new_v4().to_string(), snapshot.session_id, snapshot.draft.content_id, snapshot.sequence,
                payload, payload.len() as i64, checksum(payload.as_bytes())]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    pub fn acknowledge_recovery(&self, session: &str, content: &str, sequence: i64) -> Result<()> {
        if !self.root.join("recovery.sqlite3").exists() {
            return Ok(());
        }
        let db = self.recovery_db()?;
        let retained: Option<(String, i64)> = db
            .query_row(
                "SELECT id,sequence FROM snapshots WHERE session_id=? AND content_id=?",
                params![session, content],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        if let Some((id, retained_sequence)) = retained {
            if retained_sequence <= sequence {
                let record = self.recovery_record(&id)?;
                let current = self.read_chapter(&record.draft.id)?;
                if same_content(&current, &record.draft) {
                    db.execute(
                        "DELETE FROM snapshots WHERE id=? AND sequence=?",
                        params![id, retained_sequence],
                    )
                    .map_err(db_error)?;
                }
            }
        }
        Ok(())
    }
    fn recovery_record(&self, id: &str) -> Result<RecoveryDraft> {
        let db = self.recovery_db()?;
        let (payload, bytes, digest): (String, i64, String) = db
            .query_row(
                "SELECT payload,bytes,checksum FROM snapshots WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(db_error)?;
        if bytes != payload.len() as i64 || checksum(payload.as_bytes()) != digest {
            return Err("恢复草稿校验失败，原文件已保留；不能将此记录当作完整内容。".into());
        }
        serde_json::from_str(&payload).map_err(db_error)
    }
    pub fn list_recovery(&self) -> Result<Vec<RecoveryCandidate>> {
        if !self.root.join("recovery.sqlite3").exists() {
            return Ok(vec![]);
        }
        let db = self.recovery_db()?;
        let mut query = db
            .prepare("SELECT id FROM snapshots ORDER BY rowid")
            .map_err(db_error)?;
        let ids = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let mut candidates = vec![];
        for id in ids {
            let record = self.recovery_record(&id)?;
            let current = self.read_chapter(&record.draft.id).ok();
            if current
                .as_ref()
                .is_some_and(|c| same_content(c, &record.draft))
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
            candidates.push(RecoveryCandidate {
                id,
                sequence: record.sequence,
                draft: record.draft,
                base: record.base,
                current,
                conflict,
                integrity_error,
            });
        }
        Ok(candidates)
    }
    pub fn recover_chapter(
        &mut self,
        id: &str,
        sequence: i64,
        as_copy: bool,
    ) -> Result<LibraryView> {
        let record = self.recovery_record(id)?;
        if record.sequence != sequence {
            return Err("此恢复草稿在预览后已有更新。两份内容均保留，请刷新后重新查看。".into());
        }
        self.validate_body(
            &record.draft.body_format,
            &record.draft.body,
            &record.draft.content_id,
        )?;
        if as_copy {
            self.copy_recovery(&record.draft)?;
        } else {
            let current = self.read_chapter(&record.draft.id)?;
            if !same_base(&current, &record.base) {
                return Err(
                    "当前版本已变化，无法确认先后。两份内容均保留，请另存为恢复作品。".into(),
                );
            }
            self.save_chapter(&record.draft)?;
            self.db.execute("INSERT INTO workspace VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET chapter_id=excluded.chapter_id", [&record.draft.id]).map_err(db_error)?;
        }
        // A copy was committed completely, so only that exact journal version can be retired.
        if as_copy {
            if let Ok(db) = self.recovery_db() {
                let _ = db.execute(
                    "DELETE FROM snapshots WHERE id=? AND sequence=?",
                    params![id, record.sequence],
                );
            }
        }
        // Failure to clear a receipt never destroys the recoverable original.
        let _ = self.acknowledge_recovery(
            &record.session_id,
            &record.draft.content_id,
            record.sequence,
        );
        self.view()
    }
    fn copy_recovery(&mut self, draft: &SaveChapter) -> Result<()> {
        let work = Uuid::new_v4().to_string();
        let content = Uuid::new_v4().to_string();
        let chapter = Uuid::new_v4().to_string();
        let mut body = draft.body.clone();
        let mut attachments = vec![];
        if draft.body_format == "wab-rich-v1" {
            let mut document: serde_json::Value = serde_json::from_str(&body).map_err(db_error)?;
            fn remap(
                library: &Library,
                node: &mut serde_json::Value,
                source: &str,
                copies: &mut Vec<(String, String, String, i64)>,
            ) -> Result<()> {
                if node["type"] == "managedImage" {
                    let old = node["attrs"]["attachmentId"]
                        .as_str()
                        .ok_or("图片身份缺失。")?;
                    let (path, mime, size) = library.attachment_file(source, old)?;
                    let name: String = library
                        .db
                        .query_row("SELECT name FROM attachments WHERE id=?", [old], |r| {
                            r.get(0)
                        })
                        .map_err(db_error)?;
                    let new_id = Uuid::new_v4().to_string();
                    let bytes = fs::read(path).map_err(db_error)?;
                    if bytes.len() != size {
                        return Err("图片读取不完整，恢复尚未应用。".into());
                    }
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(library.attachment_dir()?.join(&new_id))
                        .map_err(db_error)?;
                    file.write_all(&bytes)
                        .and_then(|_| file.sync_all())
                        .map_err(db_error)?;
                    node["attrs"]["attachmentId"] = new_id.clone().into();
                    copies.push((new_id, name, mime, size as i64));
                }
                if let Some(children) = node.get_mut("content").and_then(|n| n.as_array_mut()) {
                    for child in children {
                        remap(library, child, source, copies)?;
                    }
                }
                Ok(())
            }
            remap(
                self,
                &mut document["doc"],
                &draft.content_id,
                &mut attachments,
            )?;
            body = serde_json::to_string(&document).map_err(db_error)?;
        }
        let tx = self.db.transaction().map_err(db_error)?;
        tx.execute(
            "INSERT INTO works VALUES(?,?)",
            params![work, format!("恢复作品 · {}", draft.title)],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO contents(id,body,revision,body_format) VALUES(?,?,0,?)",
            params![content, body, draft.body_format],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO chapters VALUES(?,?,?,?,0)",
            params![chapter, work, content, draft.title],
        )
        .map_err(db_error)?;
        for (id, name, mime, size) in attachments {
            tx.execute(
                "INSERT INTO attachments VALUES(?,?,?,?,?)",
                params![id, content, name, mime, size],
            )
            .map_err(db_error)?;
        }
        tx.execute("INSERT INTO workspace VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET chapter_id=excluded.chapter_id",[chapter]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(chapter: &Chapter, session: &str, sequence: i64, text: &str) -> RecoveryDraft {
        RecoveryDraft {
            session_id: session.into(),
            sequence,
            base: chapter.clone(),
            draft: SaveChapter {
                id: chapter.id.clone(),
                content_id: chapter.content_id.clone(),
                title: "恢复的标题".into(),
                body: text.into(),
                body_format: plain_format(),
                expected_revision: chapter.revision,
            },
        }
    }
    #[test]
    fn reopened_application_recovers_latest_complete_checkpoint_after_failed_main_write() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let root = temp.path().join("library");
        let mut app = Application::new(&config).unwrap();
        app.open(&root, true).unwrap();
        let chapter = app
            .library()
            .unwrap()
            .create_work("恢复测试")
            .unwrap()
            .chapter
            .unwrap();
        let session = Uuid::new_v4().to_string();
        let first = snapshot(&chapter, &session, 1, "较早完整文字");
        let latest = snapshot(&chapter, &session, 2, "最新完整中文\n第二段🙂");
        app.library().unwrap().checkpoint_chapter(&first).unwrap();
        app.library().unwrap().checkpoint_chapter(&latest).unwrap();
        app.library().unwrap().db.execute_batch("CREATE TRIGGER fail_save BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'controlled disk boundary failure'); END;").unwrap();
        assert!(app.library().unwrap().save_chapter(&latest.draft).is_err());
        drop(app);
        let mut app = Application::new(&config).unwrap();
        let original = app.restore().unwrap().unwrap().chapter.unwrap();
        assert_eq!(original.body, "");
        let records = app.library().unwrap().list_recovery().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].draft.body, latest.draft.body);
        assert!(!records[0].conflict);
        app.library()
            .unwrap()
            .db
            .execute_batch("DROP TRIGGER fail_save")
            .unwrap();
        let recovered = app
            .library()
            .unwrap()
            .recover_chapter(&records[0].id, records[0].sequence, false)
            .unwrap()
            .chapter
            .unwrap();
        assert_eq!(recovered.body, latest.draft.body);
        assert_eq!(recovered.title, latest.draft.title);
        drop(app);
        let restored = Application::new(&config)
            .unwrap()
            .restore()
            .unwrap()
            .unwrap()
            .chapter
            .unwrap();
        assert_eq!(restored.body, latest.draft.body);
    }
    #[test]
    fn competing_sessions_are_retained_and_conflict_can_only_be_copied() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("原作品").unwrap().chapter.unwrap();
        let a = snapshot(&chapter, &Uuid::new_v4().to_string(), 1, "窗口甲");
        let b = snapshot(&chapter, &Uuid::new_v4().to_string(), 1, "窗口乙");
        library.checkpoint_chapter(&a).unwrap();
        library.checkpoint_chapter(&b).unwrap();
        let records = library.list_recovery().unwrap();
        assert_eq!(records.len(), 2);
        library
            .recover_chapter(&records[0].id, records[0].sequence, false)
            .unwrap();
        let conflict = library.list_recovery().unwrap();
        assert_eq!(conflict.len(), 1);
        assert!(conflict[0].conflict);
        assert!(library
            .recover_chapter(&conflict[0].id, conflict[0].sequence, false)
            .is_err());
        let copied = library
            .recover_chapter(&conflict[0].id, conflict[0].sequence, true)
            .unwrap();
        assert_eq!(copied.works.len(), 2);
        assert_eq!(copied.chapter.unwrap().body, "窗口乙");
        assert_eq!(library.read_chapter(&chapter.id).unwrap().body, "窗口甲");
    }
    #[test]
    fn sequence_and_checksum_reject_stale_or_damaged_snapshots_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("原作品").unwrap().chapter.unwrap();
        let session = Uuid::new_v4().to_string();
        let newer = snapshot(&chapter, &session, 2, "完整草稿");
        library.checkpoint_chapter(&newer).unwrap();
        assert!(library
            .checkpoint_chapter(&snapshot(&chapter, &session, 1, "旧草稿"))
            .is_err());
        assert!(library
            .checkpoint_chapter(&snapshot(&chapter, &session, 2, "同序号不同内容"))
            .is_err());
        let candidate = library.list_recovery().unwrap().remove(0);
        assert_eq!(candidate.draft.body, "完整草稿");
        library
            .recovery_db()
            .unwrap()
            .execute("UPDATE snapshots SET payload=payload||'x'", [])
            .unwrap();
        assert!(library.list_recovery().is_err());
        assert!(library
            .recover_chapter(&candidate.id, candidate.sequence, false)
            .is_err());
        assert_eq!(library.read_chapter(&chapter.id).unwrap().body, "");
    }
    #[test]
    fn unchanged_revision_with_different_content_is_still_a_conflict_and_failed_journal_preserves_prior(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("原作品").unwrap().chapter.unwrap();
        let session = Uuid::new_v4().to_string();
        library
            .checkpoint_chapter(&snapshot(&chapter, &session, 1, "保留草稿"))
            .unwrap();
        library.recovery_db().unwrap().execute_batch("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'controlled journal failure'); END;").unwrap();
        assert!(library
            .checkpoint_chapter(&snapshot(&chapter, &session, 2, "未落盘文字"))
            .is_err());
        library
            .db
            .execute("UPDATE contents SET body='另一个可用版本'", [])
            .unwrap();
        let candidate = library.list_recovery().unwrap().remove(0);
        assert_eq!(candidate.draft.body, "保留草稿");
        assert!(candidate.conflict);
        assert!(library
            .recover_chapter(&candidate.id, candidate.sequence, false)
            .is_err());
    }
    #[test]
    fn committed_save_with_missing_acknowledgement_does_not_offer_stale_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("原作品").unwrap().chapter.unwrap();
        let draft = snapshot(&chapter, &Uuid::new_v4().to_string(), 1, "已提交但未回执");
        library.checkpoint_chapter(&draft).unwrap();
        library.save_chapter(&draft.draft).unwrap();
        drop(library);
        let library = Library::open(temp.path(), false).unwrap();
        assert!(library.list_recovery().unwrap().is_empty());
        assert_eq!(
            library.read_chapter(&chapter.id).unwrap().body,
            "已提交但未回执"
        );
    }
    #[test]
    fn recovery_copy_preserves_managed_images_and_failed_copy_preserves_original_and_journal() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("图文原作品").unwrap().chapter.unwrap();
        let mut bytes = std::io::Cursor::new(vec![]);
        image::DynamicImage::new_rgb8(3, 3)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let attachment = library
            .import_image(&chapter.content_id, "插图.png", bytes.get_ref())
            .unwrap();
        let mut record = snapshot(&chapter, &Uuid::new_v4().to_string(), 1, "");
        record.draft.body_format = "wab-rich-v1".into();
        record.draft.body=serde_json::json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"完整图文"}]},{"type":"managedImage","attrs":{"attachmentId":attachment.id,"alt":"插图"}}]}}).to_string();
        library.checkpoint_chapter(&record).unwrap();
        let candidate = library.list_recovery().unwrap().remove(0);
        library.db.execute_batch("CREATE TRIGGER fail_copy BEFORE INSERT ON chapters BEGIN SELECT RAISE(ABORT,'controlled copy failure'); END;").unwrap();
        assert!(library
            .recover_chapter(&candidate.id, candidate.sequence, true)
            .is_err());
        assert_eq!(library.view().unwrap().works.len(), 1);
        assert_eq!(library.list_recovery().unwrap().len(), 1);
        assert!(library
            .read_image(&chapter.content_id, &attachment.id)
            .is_ok());
        library.db.execute_batch("DROP TRIGGER fail_copy").unwrap();
        let restored = library
            .recover_chapter(&candidate.id, candidate.sequence, true)
            .unwrap()
            .chapter
            .unwrap();
        assert_ne!(restored.content_id, chapter.content_id);
        let value: serde_json::Value = serde_json::from_str(&restored.body).unwrap();
        let restored_image = value["doc"]["content"][1]["attrs"]["attachmentId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(restored_image, attachment.id);
        drop(library);
        let library = Library::open(temp.path(), false).unwrap();
        assert_eq!(
            library
                .read_image(&restored.content_id, &restored_image)
                .unwrap(),
            library
                .read_image(&chapter.content_id, &attachment.id)
                .unwrap()
        );
        assert_eq!(library.read_chapter(&chapter.id).unwrap().body, "");
        assert!(library.list_recovery().unwrap().is_empty());
    }
    #[test]
    fn acknowledgement_cannot_delete_an_unsaved_or_newer_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("作品").unwrap().chapter.unwrap();
        let session = Uuid::new_v4().to_string();
        let first = snapshot(&chapter, &session, 1, "第一版");
        library.checkpoint_chapter(&first).unwrap();
        library
            .acknowledge_recovery(&session, &chapter.content_id, 1)
            .unwrap();
        assert_eq!(library.list_recovery().unwrap().len(), 1);
        library
            .checkpoint_chapter(&snapshot(&chapter, &session, 2, "更新的完整草稿"))
            .unwrap();
        library.save_chapter(&first.draft).unwrap();
        library
            .acknowledge_recovery(&session, &chapter.content_id, 1)
            .unwrap();
        assert_eq!(
            library.list_recovery().unwrap()[0].draft.body,
            "更新的完整草稿"
        );
    }
    #[test]
    fn retry_after_a_lost_commit_receipt_is_idempotent_and_returns_the_real_revision() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("作品").unwrap().chapter.unwrap();
        let record = snapshot(
            &chapter,
            &Uuid::new_v4().to_string(),
            1,
            "持久化成功但回执丢失",
        );
        library.checkpoint_chapter(&record).unwrap();
        let first = library.save_chapter(&record.draft).unwrap();
        let retried = library.save_chapter(&record.draft).unwrap();
        assert_eq!(retried.revision, first.revision);
        assert_eq!(retried.body, record.draft.body);
        library
            .acknowledge_recovery(&record.session_id, &chapter.content_id, 1)
            .unwrap();
        assert!(library.list_recovery().unwrap().is_empty());
    }
    #[test]
    fn a_draft_updated_after_preview_is_not_applied_without_reviewing_the_new_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("作品").unwrap().chapter.unwrap();
        let session = Uuid::new_v4().to_string();
        library
            .checkpoint_chapter(&snapshot(&chapter, &session, 1, "预览过的草稿"))
            .unwrap();
        let candidate = library.list_recovery().unwrap().remove(0);
        library
            .checkpoint_chapter(&snapshot(&chapter, &session, 2, "预览后更新的草稿"))
            .unwrap();
        assert!(library
            .recover_chapter(&candidate.id, candidate.sequence, false)
            .is_err());
        assert!(library
            .recover_chapter(&candidate.id, candidate.sequence, true)
            .is_err());
        assert_eq!(library.read_chapter(&chapter.id).unwrap().body, "");
        assert_eq!(
            library.list_recovery().unwrap()[0].draft.body,
            "预览后更新的草稿"
        );
    }
}
