use super::*;
use rusqlite::{Transaction, TransactionBehavior};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResumePosition {
    pub id: String,
    pub title: String,
    pub kind: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub content_id: String,
    pub title: String,
    pub kind: String,
    pub volume_id: Option<String>,
    pub position: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub id: String,
    pub title: String,
    pub position: i64,
}
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StructureChange {
    CreateEntry {
        work_id: String,
        kind: String,
        title: String,
        volume_id: Option<String>,
        expected_revision: i64,
    },
    CreateVolume {
        work_id: String,
        title: String,
        expected_revision: i64,
    },
    RenameVolume {
        work_id: String,
        id: String,
        title: String,
        expected_revision: i64,
    },
    Move {
        work_id: String,
        id: String,
        volume_id: Option<String>,
        before_id: Option<String>,
        expected_revision: i64,
    },
    CompileFragment {
        work_id: String,
        id: String,
        volume_id: Option<String>,
        before_id: Option<String>,
        expected_revision: i64,
    },
}
pub(super) fn remember(db: &Connection, id: &str) -> Result<()> {
    let work: String = db
        .query_row("SELECT work_id FROM chapters WHERE id=?", [id], |r| {
            r.get(0)
        })
        .map_err(db_error)?;
    let changed = db
        .execute(
            "UPDATE work_state SET last_entry_id=? WHERE work_id=?",
            params![id, work],
        )
        .map_err(db_error)?;
    if changed != 1 {
        return Err("作品继续位置无法保存，原目录已保留。".into());
    }
    db.execute("INSERT INTO workspace(singleton,chapter_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET chapter_id=excluded.chapter_id",[id]).map_err(db_error)?;
    Ok(())
}
impl Library {
    pub(super) fn read_works(&self) -> Result<Vec<Work>> {
        let mut query=self.db.prepare("SELECT w.id,w.title,s.structure_revision,c.id,c.title,c.kind FROM works w JOIN work_state s ON s.work_id=w.id JOIN chapters c ON c.id=s.last_entry_id ORDER BY w.rowid").map_err(db_error)?;
        let rows = query
            .query_map([], |r| {
                Ok(Work {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    structure_revision: r.get(2)?,
                    last_entry: Some(ResumePosition {
                        id: r.get(3)?,
                        title: r.get(4)?,
                        kind: r.get(5)?,
                    }),
                })
            })
            .map_err(db_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)
    }
    pub(super) fn read_entries(&self, work: &str) -> Result<Vec<Entry>> {
        let mut query=self.db.prepare("SELECT id,content_id,title,kind,volume_id,position FROM chapters WHERE work_id=? ORDER BY position,id").map_err(db_error)?;
        let rows = query
            .query_map([work], |r| {
                Ok(Entry {
                    id: r.get(0)?,
                    content_id: r.get(1)?,
                    title: r.get(2)?,
                    kind: r.get(3)?,
                    volume_id: r.get(4)?,
                    position: r.get(5)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)
    }
    pub(super) fn read_volumes(&self, work: &str) -> Result<Vec<Volume>> {
        let mut query = self
            .db
            .prepare("SELECT id,title,position FROM volumes WHERE work_id=? ORDER BY position,id")
            .map_err(db_error)?;
        let rows = query
            .query_map([work], |r| {
                Ok(Volume {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    position: r.get(2)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)
    }
    pub fn change_structure(&mut self, change: StructureChange) -> Result<LibraryView> {
        use StructureChange::*;
        let (work, expected) = match &change {
            CreateEntry {
                work_id,
                expected_revision,
                ..
            }
            | CreateVolume {
                work_id,
                expected_revision,
                ..
            }
            | RenameVolume {
                work_id,
                expected_revision,
                ..
            }
            | Move {
                work_id,
                expected_revision,
                ..
            }
            | CompileFragment {
                work_id,
                expected_revision,
                ..
            } => (work_id, expected_revision),
        };
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if tx.execute("UPDATE work_state SET structure_revision=structure_revision+1 WHERE work_id=? AND structure_revision=?",params![work,expected]).map_err(db_error)?!=1 {
            return Err("目录已在其他窗口变化。原目录与当前正文已保留，请重新打开作品后再整理。".into());
        }
        match &change {
            CreateEntry {
                kind,
                title,
                volume_id,
                ..
            } => {
                if kind != "chapter" && kind != "fragment" {
                    return Err("正文类型无效。".into());
                }
                if kind == "fragment" && volume_id.is_some() {
                    return Err("未编章片段不能放入卷，请先编为新章节。".into());
                }
                validate_volume(&tx, work, volume_id.as_deref())?;
                let id = Uuid::new_v4().to_string();
                let content = Uuid::new_v4().to_string();
                let position = if kind == "fragment" {
                    tx.query_row("SELECT coalesce(max(position),-1)+1 FROM chapters WHERE work_id=? AND kind='fragment'",[work],|r|r.get::<_,i64>(0)).map_err(db_error)?
                } else {
                    let ids = siblings(&tx, work, volume_id.as_deref())?;
                    write_order(&tx, &ids)?;
                    ids.len() as i64
                };
                tx.execute(
                    "INSERT INTO contents(id,body,revision) VALUES(?,'',0)",
                    [&content],
                )
                .map_err(db_error)?;
                tx.execute("INSERT INTO chapters(id,work_id,content_id,title,position,kind,volume_id) VALUES(?,?,?,?,?,?,?)",params![id,work,content,default_title(title,if kind=="fragment" {"未命名片段"}else{"未命名章节"}),position,kind,volume_id]).map_err(db_error)?;
                remember(&tx, &id)?;
            }
            CreateVolume { title, .. } => {
                let id = Uuid::new_v4().to_string();
                let ids = siblings(&tx, work, None)?;
                write_order(&tx, &ids)?;
                let position = ids.len() as i64;
                tx.execute(
                    "INSERT INTO volumes(id,work_id,title,position) VALUES(?,?,?,?)",
                    params![id, work, default_title(title, "未命名卷"), position],
                )
                .map_err(db_error)?;
            }
            RenameVolume { id, title, .. } => {
                if tx
                    .execute(
                        "UPDATE volumes SET title=? WHERE id=? AND work_id=?",
                        params![default_title(title, "未命名卷"), id, work],
                    )
                    .map_err(db_error)?
                    != 1
                {
                    return Err("卷不属于当前作品，原目录已保留。".into());
                }
            }
            Move {
                id,
                volume_id,
                before_id,
                ..
            }
            | CompileFragment {
                id,
                volume_id,
                before_id,
                ..
            } => {
                validate_volume(&tx, work, volume_id.as_deref())?;
                let is_volume: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM volumes WHERE id=? AND work_id=?)",
                        params![id, work],
                        |r| r.get(0),
                    )
                    .map_err(db_error)?;
                let compile = matches!(&change, CompileFragment { .. });
                let mut old_parent = None;
                if is_volume {
                    if compile || volume_id.is_some() {
                        return Err("卷只能在当前作品的目录顶层排序。".into());
                    }
                } else {
                    let (kind, parent): (String, Option<String>) = tx
                        .query_row(
                            "SELECT kind,volume_id FROM chapters WHERE id=? AND work_id=?",
                            params![id, work],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .map_err(db_error)?;
                    if compile != (kind == "fragment") {
                        return Err("片段请使用“编为新章节”；章节移动不复制正文。".into());
                    }
                    old_parent = parent;
                }
                let mut target = siblings(&tx, work, volume_id.as_deref())?;
                target.retain(|item| item != id);
                let index = match before_id {
                    Some(before) => target
                        .iter()
                        .position(|item| item == before)
                        .ok_or("目标位置已变化或不属于目标目录，原目录已保留。")?,
                    None => target.len(),
                };
                target.insert(index, id.clone());
                if !is_volume {
                    tx.execute(
                        "UPDATE chapters SET kind='chapter',volume_id=? WHERE id=? AND work_id=?",
                        params![volume_id, id, work],
                    )
                    .map_err(db_error)?;
                }
                if old_parent != *volume_id {
                    let source = siblings(&tx, work, old_parent.as_deref())?;
                    write_order(&tx, &source)?;
                }
                write_order(&tx, &target)?;
                // A structural move changes neither content revision nor attachment ownership.
                if compile {
                    remember(&tx, id)?;
                }
            }
        }
        tx.commit().map_err(db_error)?;
        self.view()
    }
}
fn default_title<'a>(title: &'a str, fallback: &'a str) -> &'a str {
    if title.trim().is_empty() {
        fallback
    } else {
        title.trim()
    }
}
fn validate_volume(db: &Connection, work: &str, volume: Option<&str>) -> Result<()> {
    if let Some(volume) = volume {
        let valid: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM volumes WHERE id=? AND work_id=?)",
                params![volume, work],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if !valid {
            return Err("目标卷不属于当前作品，原目录已保留。".into());
        }
    }
    Ok(())
}
fn siblings(db: &Connection, work: &str, parent: Option<&str>) -> Result<Vec<String>> {
    let mut query=db.prepare("SELECT id FROM (SELECT id,position FROM chapters WHERE work_id=?1 AND kind='chapter' AND volume_id IS ?2 UNION ALL SELECT id,position FROM volumes WHERE work_id=?1 AND ?2 IS NULL) ORDER BY position,id").map_err(db_error)?;
    let rows = query
        .query_map(params![work, parent], |r| r.get(0))
        .map_err(db_error)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)
}
fn write_order(tx: &Transaction<'_>, ids: &[String]) -> Result<()> {
    for (position, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE chapters SET position=? WHERE id=?",
            params![position as i64, id],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE volumes SET position=? WHERE id=?",
            params![position as i64, id],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn change(library: &mut Library, work: &str, mut value: Value) -> LibraryView {
        let revision = library
            .read_works()
            .unwrap()
            .iter()
            .find(|w| w.id == work)
            .unwrap()
            .structure_revision;
        value["workId"] = work.into();
        value["expectedRevision"] = revision.into();
        library
            .change_structure(serde_json::from_value(value).unwrap())
            .unwrap()
    }
    fn draft(chapter: &Chapter, body: String, format: &str) -> SaveChapter {
        SaveChapter {
            id: chapter.id.clone(),
            content_id: chapter.content_id.clone(),
            title: chapter.title.clone(),
            body,
            body_format: format.into(),
            expected_revision: chapter.revision,
        }
    }
    fn root_ids(library: &Library, work: &str) -> Vec<String> {
        siblings(&library.db, work, None).unwrap()
    }
    #[test]
    fn author_orders_optional_volumes_and_compiles_the_same_rich_fragment_then_reopens_each_work() {
        let tmp = tempfile::tempdir().unwrap();
        let mut library = Library::open(tmp.path(), true).unwrap();
        let first = library.create_work("暂名").unwrap().chapter.unwrap();
        let work = first.work_id.clone();
        change(
            &mut library,
            &work,
            json!({"type":"createVolume","title":"卷甲"}),
        );
        let volume = library.read_volumes(&work).unwrap()[0].id.clone();
        change(
            &mut library,
            &work,
            json!({"type":"createVolume","title":"卷乙"}),
        );
        let second_volume = library.read_volumes(&work).unwrap()[1].id.clone();
        change(
            &mut library,
            &work,
            json!({"type":"move","id":second_volume,"volumeId":null,"beforeId":first.id}),
        );
        change(
            &mut library,
            &work,
            json!({"type":"createEntry","kind":"chapter","title":"同名","volumeId":volume}),
        );
        let chapter = library.view().unwrap().chapter.unwrap();
        change(
            &mut library,
            &work,
            json!({"type":"createEntry","kind":"fragment","title":"同名","volumeId":null}),
        );
        let fragment = library.view().unwrap().chapter.unwrap();
        let mut bytes = std::io::Cursor::new(vec![]);
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let attachment = library
            .import_image(&fragment.content_id, "虚构.png", bytes.get_ref())
            .unwrap();
        let body=json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"先写的正文，保持原样。"}]},{"type":"managedImage","attrs":{"attachmentId":attachment.id,"alt":"虚构图片"}}]}}).to_string();
        let saved = library
            .save_chapter(&draft(&fragment, body.clone(), "wab-rich-v1"))
            .unwrap();
        // Keep a complete old-format recovery snapshot across the structural operation.
        library
            .checkpoint_chapter(&RecoveryDraft {
                session_id: Uuid::new_v4().to_string(),
                sequence: 1,
                base: saved.clone(),
                draft: draft(&saved, body.replace("保持原样", "恢复末句"), "wab-rich-v1"),
            })
            .unwrap();
        change(
            &mut library,
            &work,
            json!({"type":"compileFragment","id":fragment.id,"volumeId":volume,"beforeId":chapter.id}),
        );
        let converted = library.read_chapter(&fragment.id).unwrap();
        assert_eq!(converted.content_id, fragment.content_id);
        assert_eq!(converted.body, body);
        assert_eq!(converted.revision, saved.revision);
        assert_eq!(
            siblings(&library.db, &work, Some(&volume)).unwrap(),
            vec![fragment.id.clone(), chapter.id.clone()]
        );
        assert!(library
            .read_entries(&work)
            .unwrap()
            .iter()
            .all(|entry| entry.kind == "chapter"));
        assert_eq!(
            library
                .db
                .query_row("SELECT count(*) FROM contents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            library
                .db
                .query_row("SELECT count(*) FROM attachments", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(library
            .read_image(&fragment.content_id, &attachment.id)
            .is_ok());
        let other = library.create_work("暂名").unwrap().chapter.unwrap();
        assert_eq!(library.select_work(&work).unwrap().id, fragment.id);
        assert_eq!(library.read_entries(&other.work_id).unwrap().len(), 1);
        assert_eq!(
            root_ids(&library, &work),
            vec![second_volume, first.id, volume.clone()]
        );
        drop(library);
        let mut library = Library::open(tmp.path(), false).unwrap();
        assert_eq!(library.view().unwrap().chapter.unwrap().id, fragment.id);
        assert_eq!(library.select_work(&other.work_id).unwrap().id, other.id);
        library.select_work(&work).unwrap();
        let record = library.list_recovery().unwrap().remove(0);
        assert!(!record.conflict);
        library
            .recover_chapter(&record.id, record.sequence, false)
            .unwrap();
        assert!(library
            .read_chapter(&fragment.id)
            .unwrap()
            .body
            .contains("恢复末句"));
        assert_eq!(
            library
                .read_entries(&work)
                .unwrap()
                .iter()
                .find(|e| e.id == fragment.id)
                .unwrap()
                .volume_id,
            Some(volume)
        );
    }
    #[test]
    fn invalid_cross_work_stale_or_failed_moves_leave_body_order_revision_and_selection_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let mut library = Library::open(tmp.path(), true).unwrap();
        let a = library.create_work("甲").unwrap().chapter.unwrap();
        let b = library.create_work("乙").unwrap().chapter.unwrap();
        change(
            &mut library,
            &b.work_id,
            json!({"type":"createVolume","title":"乙卷"}),
        );
        let foreign = library.read_volumes(&b.work_id).unwrap()[0].id.clone();
        change(
            &mut library,
            &a.work_id,
            json!({"type":"createEntry","kind":"fragment","title":"片段","volumeId":null}),
        );
        let fragment = library.view().unwrap().chapter.unwrap();
        library
            .save_chapter(&draft(&fragment, "保留末句".into(), "plain-text"))
            .unwrap();
        let before = serde_json::to_value(library.view().unwrap()).unwrap();
        let revision = library
            .read_works()
            .unwrap()
            .iter()
            .find(|w| w.id == a.work_id)
            .unwrap()
            .structure_revision;
        for value in [
            json!({"type":"compileFragment","workId":a.work_id,"expectedRevision":revision,"id":fragment.id,"volumeId":foreign,"beforeId":null}),
            json!({"type":"move","workId":a.work_id,"expectedRevision":revision,"id":b.id,"volumeId":null,"beforeId":null}),
            json!({"type":"compileFragment","workId":a.work_id,"expectedRevision":revision-1,"id":fragment.id,"volumeId":null,"beforeId":null}),
            json!({"type":"compileFragment","workId":a.work_id,"expectedRevision":revision,"id":fragment.id,"volumeId":null,"beforeId":b.id}),
        ] {
            assert!(library
                .change_structure(serde_json::from_value(value).unwrap())
                .is_err());
            assert_eq!(
                serde_json::to_value(library.view().unwrap()).unwrap(),
                before
            );
        }
        library.db.execute_batch("CREATE TRIGGER fail_move BEFORE UPDATE OF position ON chapters BEGIN SELECT RAISE(ABORT,'controlled structural write failure');END;").unwrap();
        assert!(library.change_structure(serde_json::from_value(json!({"type":"compileFragment","workId":a.work_id,"expectedRevision":revision,"id":fragment.id,"volumeId":null,"beforeId":a.id})).unwrap()).is_err());
        assert_eq!(
            serde_json::to_value(library.view().unwrap()).unwrap(),
            before
        );
        drop(library);
        assert_eq!(
            Library::open(tmp.path(), false)
                .unwrap()
                .read_chapter(&fragment.id)
                .unwrap()
                .body,
            "保留末句"
        );
    }
}

#[cfg(test)]
mod fragment_recovery_tests {
    use super::*;
    #[test]
    fn uncompiled_fragment_failed_write_retains_the_full_checkpoint_and_conflict_copy_preserves_kind(
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let mut library = Library::open(tmp.path(), true).unwrap();
        let work = library
            .create_work("片段恢复")
            .unwrap()
            .chapter
            .unwrap()
            .work_id;
        let view = library
            .change_structure(StructureChange::CreateEntry {
                work_id: work.clone(),
                kind: "fragment".into(),
                title: "暂未编章".into(),
                volume_id: None,
                expected_revision: 0,
            })
            .unwrap();
        let base = view.chapter.unwrap();
        let draft = SaveChapter {
            id: base.id.clone(),
            content_id: base.content_id.clone(),
            title: base.title.clone(),
            body: "片段未保存时的完整末句。".into(),
            body_format: plain_format(),
            expected_revision: 0,
        };
        library
            .checkpoint_chapter(&RecoveryDraft {
                session_id: Uuid::new_v4().to_string(),
                sequence: 1,
                base: base.clone(),
                draft: draft.clone(),
            })
            .unwrap();
        library.db.execute_batch("CREATE TRIGGER fail_fragment BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'controlled failure');END;").unwrap();
        assert!(library.save_chapter(&draft).is_err());
        drop(library);
        let mut library = Library::open(tmp.path(), false).unwrap();
        let retained = library.list_recovery().unwrap().remove(0);
        assert_eq!(retained.draft.body, draft.body);
        assert!(!retained.conflict);
        library
            .db
            .execute_batch("DROP TRIGGER fail_fragment;")
            .unwrap();
        let other = SaveChapter {
            body: "另一份已保存正文。".into(),
            ..draft.clone()
        };
        library.save_chapter(&other).unwrap();
        assert!(library.list_recovery().unwrap()[0].conflict);
        let copy = library.recover_chapter(&retained.id, 1, true).unwrap();
        assert_eq!(copy.entries[0].kind, "fragment");
        let recovered = copy.chapter.unwrap();
        assert_ne!(recovered.content_id, base.content_id);
        assert_eq!(recovered.body, draft.body);
        assert_eq!(library.read_chapter(&base.id).unwrap().body, other.body);
        drop(library);
        let reopened = Library::open(tmp.path(), false).unwrap().view().unwrap();
        assert_eq!(reopened.chapter.unwrap().id, recovered.id);
        assert_eq!(reopened.entries[0].kind, "fragment");
    }
}
