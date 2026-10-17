use super::*;
use rusqlite::TransactionBehavior;

// Validate before migrating; every schema and metadata change shares one transaction.
pub(super) fn initialize(db: &mut Connection, existed: bool, version: i64) -> Result<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if !existed {
        tx.execute_batch("
            CREATE TABLE works(id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE contents(id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
            CREATE TABLE chapters(id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
                content_id TEXT NOT NULL UNIQUE REFERENCES contents(id), title TEXT NOT NULL, position INTEGER NOT NULL);
            CREATE TABLE workspace(singleton INTEGER PRIMARY KEY CHECK(singleton=1), chapter_id TEXT REFERENCES chapters(id));
            PRAGMA application_id=1463894577;
        ").map_err(db_error)?;
    } else {
        let integrity: String = tx
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(db_error)?;
        if integrity != "ok" {
            return Err("资料库完整性检查失败，原库未迁移。".into());
        }
        for (table, columns) in [
            ("works", vec![("id", "TEXT"), ("title", "TEXT")]),
            (
                "contents",
                vec![("id", "TEXT"), ("body", "TEXT"), ("revision", "INTEGER")],
            ),
            (
                "chapters",
                vec![
                    ("id", "TEXT"),
                    ("work_id", "TEXT"),
                    ("content_id", "TEXT"),
                    ("title", "TEXT"),
                    ("position", "INTEGER"),
                ],
            ),
            (
                "workspace",
                vec![("singleton", "INTEGER"), ("chapter_id", "TEXT")],
            ),
        ] {
            validate_columns(&tx, table, &columns)?;
        }
        if version >= 2 {
            validate_columns(&tx, "contents", &[("body_format", "TEXT")])?;
            validate_columns(
                &tx,
                "attachments",
                &[
                    ("id", "TEXT"),
                    ("content_id", "TEXT"),
                    ("name", "TEXT"),
                    ("mime", "TEXT"),
                    ("size", "INTEGER"),
                ],
            )?;
        }
        if version >= 2 {
            let invalid: i64 = tx.query_row("SELECT (SELECT count(*) FROM contents WHERE typeof(body_format)!='text') +
                (SELECT count(*) FROM attachments a WHERE typeof(a.id)!='text' OR a.id='' OR typeof(a.name)!='text' OR typeof(a.mime)!='text' OR typeof(a.size)!='integer' OR a.size<0 OR NOT EXISTS(SELECT 1 FROM contents t WHERE t.id=a.content_id))",[],|r|r.get(0)).map_err(db_error)?;
            if invalid != 0 {
                return Err("资料库图文元数据无法确认，原库未迁移。".into());
            }
        }
        let invalid: i64 = tx.query_row("SELECT
            (SELECT count(*) FROM works WHERE typeof(id)!='text' OR id='' OR typeof(title)!='text') +
            (SELECT count(*) FROM contents WHERE typeof(id)!='text' OR id='' OR typeof(body)!='text' OR typeof(revision)!='integer' OR revision<0) +
            (SELECT count(*) FROM chapters c WHERE typeof(c.id)!='text' OR c.id='' OR typeof(c.title)!='text' OR typeof(c.position)!='integer' OR c.position<0
                OR NOT EXISTS(SELECT 1 FROM works w WHERE w.id=c.work_id) OR NOT EXISTS(SELECT 1 FROM contents t WHERE t.id=c.content_id)) +
            (SELECT count(*) FROM (SELECT content_id FROM chapters GROUP BY content_id HAVING count(*)>1)) +
            (SELECT count(*) FROM workspace WHERE singleton!=1 OR (chapter_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM chapters c WHERE c.id=chapter_id))) +
            (SELECT count(*) FROM works w WHERE NOT EXISTS(SELECT 1 FROM chapters c WHERE c.work_id=w.id))", [], |r| r.get(0)).map_err(db_error)?;
        let foreign_keys = tx
            .prepare("PRAGMA foreign_key_check")
            .map_err(db_error)?
            .exists([])
            .map_err(db_error)?;
        if invalid != 0 || foreign_keys {
            return Err("资料库数据或关联无法确认，原库未迁移。".into());
        }
        if version < 3 {
            let ambiguous: i64 = tx.query_row("SELECT count(*) FROM (SELECT work_id,position FROM chapters GROUP BY work_id,position HAVING count(*)>1)",[],|r|r.get(0)).map_err(db_error)?;
            if ambiguous != 0 {
                return Err("旧目录顺序存在冲突，原库未迁移。".into());
            }
        }
    }
    if !existed || version < 2 {
        tx.execute_batch("ALTER TABLE contents ADD COLUMN body_format TEXT NOT NULL DEFAULT 'plain-text';
            CREATE TABLE attachments(id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES contents(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);").map_err(db_error)?;
    }
    if !existed || version < 3 {
        tx.execute_batch("CREATE TABLE volumes(id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), title TEXT NOT NULL, position INTEGER NOT NULL);
            ALTER TABLE chapters ADD COLUMN kind TEXT NOT NULL DEFAULT 'chapter' CHECK(kind IN ('chapter','fragment'));
            ALTER TABLE chapters ADD COLUMN volume_id TEXT REFERENCES volumes(id);
            CREATE TABLE work_state(work_id TEXT PRIMARY KEY REFERENCES works(id), last_entry_id TEXT NOT NULL REFERENCES chapters(id), structure_revision INTEGER NOT NULL DEFAULT 0);
            INSERT INTO work_state(work_id,last_entry_id)
                SELECT w.id,coalesce((SELECT c.id FROM chapters c JOIN workspace s ON s.chapter_id=c.id WHERE c.work_id=w.id AND s.singleton=1),
                    (SELECT c.id FROM chapters c WHERE c.work_id=w.id ORDER BY c.position,c.id LIMIT 1)) FROM works w;
            PRAGMA user_version=3;").map_err(db_error)?;
    }
    validate_columns(&tx, "chapters", &[("kind", "TEXT"), ("volume_id", "TEXT")])?;
    validate_columns(
        &tx,
        "volumes",
        &[
            ("id", "TEXT"),
            ("work_id", "TEXT"),
            ("title", "TEXT"),
            ("position", "INTEGER"),
        ],
    )?;
    validate_columns(
        &tx,
        "work_state",
        &[
            ("work_id", "TEXT"),
            ("last_entry_id", "TEXT"),
            ("structure_revision", "INTEGER"),
        ],
    )?;
    let invalid: i64 = tx.query_row("SELECT
        (SELECT count(*) FROM chapters c WHERE typeof(kind)!='text' OR kind NOT IN ('chapter','fragment') OR (kind='fragment' AND volume_id IS NOT NULL)
            OR (volume_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM volumes v WHERE v.id=c.volume_id AND v.work_id=c.work_id))) +
        (SELECT count(*) FROM volumes v WHERE typeof(v.id)!='text' OR v.id='' OR typeof(v.title)!='text' OR typeof(v.position)!='integer' OR v.position<0 OR NOT EXISTS(SELECT 1 FROM works w WHERE w.id=v.work_id) OR EXISTS(SELECT 1 FROM chapters c WHERE c.id=v.id)) +
        (SELECT count(*) FROM works w WHERE NOT EXISTS(SELECT 1 FROM work_state s JOIN chapters c ON c.id=s.last_entry_id WHERE s.work_id=w.id AND c.work_id=w.id AND typeof(s.structure_revision)='integer' AND s.structure_revision>=0)) +
        (SELECT count(*) FROM (SELECT work_id,coalesce(volume_id,''),position FROM chapters WHERE kind='chapter' GROUP BY work_id,coalesce(volume_id,''),position HAVING count(*)>1)) +
        (SELECT count(*) FROM (SELECT work_id,position FROM chapters WHERE kind='fragment' GROUP BY work_id,position HAVING count(*)>1)) +
        (SELECT count(*) FROM (SELECT work_id,position FROM (SELECT work_id,position FROM volumes UNION ALL SELECT work_id,position FROM chapters WHERE kind='chapter' AND volume_id IS NULL) GROUP BY work_id,position HAVING count(*)>1))",[],|r|r.get(0)).map_err(db_error)?;
    if invalid != 0 {
        return Err("目录结构或继续位置无法确认，原库未修改。".into());
    }
    tx.commit().map_err(db_error)
}
fn validate_columns(db: &Connection, table: &str, expected: &[(&str, &str)]) -> Result<()> {
    let mut query = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(db_error)?;
    let columns = query
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if expected.iter().any(|(name, kind)| {
        !columns
            .iter()
            .any(|(actual, ty)| actual == name && ty.eq_ignore_ascii_case(kind))
    }) {
        return Err("资料库表结构无法确认，原库未修改。".into());
    }
    let primary: Vec<String> = {
        let mut query = db
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(db_error)?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(5)?)))
            .map_err(db_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?
            .into_iter()
            .filter(|(_, pk)| *pk > 0)
            .map(|(name, _)| name)
            .collect()
    };
    let key = match table {
        "workspace" => "singleton",
        "work_state" => "work_id",
        _ => "id",
    };
    if primary != vec![key.to_string()] {
        return Err("资料库稳定身份约束无法确认，原库未修改。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn old_library(root: &Path, version: i64) {
        let db = Connection::open(root.join("library.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE works(id TEXT PRIMARY KEY,title TEXT NOT NULL,legacy_note TEXT);
            CREATE TABLE contents(id TEXT PRIMARY KEY,body TEXT NOT NULL,revision INTEGER NOT NULL);
            CREATE TABLE chapters(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id),content_id TEXT NOT NULL UNIQUE REFERENCES contents(id),title TEXT NOT NULL,position INTEGER NOT NULL,legacy_note TEXT);
            CREATE TABLE workspace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),chapter_id TEXT REFERENCES chapters(id));
            INSERT INTO works VALUES('work-a','同名','保留元数据甲'),('work-b','同名','保留元数据乙');
            INSERT INTO contents VALUES('content-a','甲正文',3),('content-b','乙正文',0);
            INSERT INTO chapters VALUES('entry-a','work-a','content-a','同名章',8,'章节元数据'),('entry-b','work-b','content-b','同名章',0,'另一份');
            INSERT INTO workspace VALUES(1,'entry-a');
            PRAGMA application_id=1463894577; PRAGMA user_version=1;").unwrap();
        if version == 2 {
            db.execute_batch("ALTER TABLE contents ADD COLUMN body_format TEXT NOT NULL DEFAULT 'plain-text'; CREATE TABLE attachments(id TEXT PRIMARY KEY,content_id TEXT NOT NULL REFERENCES contents(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL);PRAGMA user_version=2;").unwrap();
        }
    }
    #[test]
    fn migrates_both_old_versions_without_matching_titles_or_losing_metadata_and_reads_old_journal()
    {
        for version in [1, 2] {
            let tmp = tempfile::tempdir().unwrap();
            old_library(tmp.path(), version);
            let base = Chapter {
                id: "entry-a".into(),
                work_id: "work-a".into(),
                content_id: "content-a".into(),
                title: "同名章".into(),
                body: "甲正文".into(),
                body_format: plain_format(),
                revision: 3,
            };
            let snapshot = RecoveryDraft {
                session_id: Uuid::new_v4().to_string(),
                sequence: 1,
                base: base.clone(),
                draft: SaveChapter {
                    id: base.id.clone(),
                    content_id: base.content_id.clone(),
                    title: base.title.clone(),
                    body: "旧日志末句".into(),
                    body_format: plain_format(),
                    expected_revision: 3,
                },
            };
            let payload = serde_json::to_string(&snapshot).unwrap();
            let hash = payload
                .as_bytes()
                .iter()
                .fold(0xcbf29ce484222325u64, |h, b| {
                    (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
                });
            let journal = Connection::open(tmp.path().join("recovery.sqlite3")).unwrap();
            journal.execute_batch("CREATE TABLE snapshots(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,content_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL,checksum TEXT NOT NULL,UNIQUE(session_id,content_id)); PRAGMA application_id=1463898673; PRAGMA user_version=1;").unwrap();
            journal
                .execute(
                    "INSERT INTO snapshots VALUES('old-record',?,?,?,?,?,?)",
                    params![
                        snapshot.session_id,
                        base.content_id,
                        1,
                        payload,
                        payload.len() as i64,
                        format!("{hash:016x}")
                    ],
                )
                .unwrap();
            drop(journal);
            let mut library = Library::open(tmp.path(), false).unwrap();
            assert_eq!(library.view().unwrap().chapter.unwrap().id, "entry-a");
            assert_eq!(library.list_recovery().unwrap().len(), 1);
            assert!(!library.list_recovery().unwrap()[0].conflict);
            library.recover_chapter("old-record", 1, false).unwrap();
            assert_eq!(library.read_chapter("entry-a").unwrap().body, "旧日志末句");
            assert_eq!(library.read_chapter("entry-b").unwrap().body, "乙正文");
            let note: String = library
                .db
                .query_row(
                    "SELECT legacy_note FROM chapters WHERE id='entry-a'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(note, "章节元数据");
            assert_eq!(
                library.select_work("work-b").unwrap().content_id,
                "content-b"
            );
            drop(library);
            assert_eq!(
                Library::open(tmp.path(), false)
                    .unwrap()
                    .view()
                    .unwrap()
                    .chapter
                    .unwrap()
                    .id,
                "entry-b"
            );
        }
    }
    #[test]
    fn ambiguous_data_and_failed_schema_migration_leave_old_database_bytes_unchanged() {
        for invalid in ["ambiguous", "schema-failure", "blob", "missing-primary"] {
            let tmp = tempfile::tempdir().unwrap();
            old_library(tmp.path(), 1);
            let db = Connection::open(tmp.path().join("library.sqlite3")).unwrap();
            if invalid == "ambiguous" {
                db.execute_batch("INSERT INTO contents VALUES('extra','不确定顺序',0);INSERT INTO chapters VALUES('extra','work-a','extra','同名章',8,'保留');").unwrap();
            } else if invalid == "blob" {
                db.execute_batch("UPDATE contents SET body=X'01';").unwrap();
            } else if invalid == "missing-primary" {
                db.execute_batch("PRAGMA foreign_keys=OFF;ALTER TABLE contents RENAME TO old_contents; CREATE TABLE contents(id TEXT,body TEXT NOT NULL,revision INTEGER NOT NULL);INSERT INTO contents SELECT * FROM old_contents; DROP TABLE old_contents;").unwrap();
            } else {
                db.execute_batch("CREATE TABLE volumes(id TEXT PRIMARY KEY);")
                    .unwrap();
            }
            drop(db);
            let path = tmp.path().join("library.sqlite3");
            let bytes = fs::read(&path).unwrap();
            assert!(Library::open(tmp.path(), false).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            let db = Connection::open(&path).unwrap();
            assert_eq!(
                db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert!(db.prepare("SELECT body_format FROM contents").is_err());
        }
    }
}
