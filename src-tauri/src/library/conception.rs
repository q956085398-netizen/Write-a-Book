use super::*;
use rusqlite::Transaction;
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConceptionSection {
    pub id: String,
    pub name: String,
    pub hidden: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptionDefaults {
    pub revision: i64,
    pub sections: Vec<ConceptionSection>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptionRecord {
    pub id: String,
    pub work_id: String,
    pub content_id: String,
    pub title: String,
    pub body: String,
    pub body_format: String,
    pub revision: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConception {
    pub id: String,
    pub content_id: String,
    pub title: String,
    pub body: String,
    #[serde(default = "plain_format")]
    pub body_format: String,
    pub expected_revision: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptionReference {
    pub id: String,
    pub record_id: String,
    pub section_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptionView {
    pub work_id: String,
    pub work_title: String,
    pub revision: i64,
    pub sections: Vec<ConceptionSection>,
    pub records: Vec<ConceptionRecord>,
    pub references: Vec<ConceptionReference>,
}
fn candidates() -> Vec<ConceptionSection> {
    [
        "故事核心",
        "人物与关系",
        "世界与设定",
        "剧情储备",
        "大纲与细纲",
        "伏笔与线索",
        "本书参考",
    ]
    .into_iter()
    .enumerate()
    .map(|(index, name)| ConceptionSection {
        id: format!("candidate-{index}"),
        name: name.into(),
        hidden: false,
    })
    .collect()
}
fn validate_sections(sections: &[ConceptionSection]) -> Result<()> {
    let mut ids = HashSet::new();
    for section in sections {
        if section.id.is_empty()
            || section.id.len() > 200
            || !ids.insert(&section.id)
            || section.name.trim().is_empty()
            || section.name.chars().count() > 100
        {
            return Err("分区身份重复、名称为空或过长，原配置未修改。".into());
        }
    }
    Ok(())
}
// Schema 4 adds conception identities alongside chapters. Existing text and unknown columns
// remain untouched; the caller encloses validation, migration and version in one transaction.
pub(super) fn initialize(tx: &Transaction<'_>, existed: bool, version: i64) -> Result<()> {
    if !existed || version < 4 {
        tx.execute_batch("CREATE TABLE conception_defaults(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, sections TEXT NOT NULL);
            CREATE TABLE conception_work_state(work_id TEXT PRIMARY KEY REFERENCES works(id), revision INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE conception_sections(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id),name TEXT NOT NULL,hidden INTEGER NOT NULL CHECK(hidden IN (0,1)),position INTEGER NOT NULL);
            CREATE TABLE conception_records(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id),content_id TEXT NOT NULL UNIQUE REFERENCES contents(id),title TEXT NOT NULL);
            CREATE TABLE conception_references(id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES conception_records(id),section_id TEXT NOT NULL REFERENCES conception_sections(id),position INTEGER NOT NULL,UNIQUE(record_id,section_id));
            CREATE TRIGGER conception_reference_work BEFORE INSERT ON conception_references WHEN
                (SELECT work_id FROM conception_records WHERE id=NEW.record_id)!=(SELECT work_id FROM conception_sections WHERE id=NEW.section_id)
                BEGIN SELECT RAISE(ABORT,'构思引用不能跨作品'); END;").map_err(db_error)?;
        tx.execute(
            "INSERT INTO conception_defaults VALUES(1,0,?)",
            [serde_json::to_string(&candidates()).map_err(db_error)?],
        )
        .map_err(db_error)?;
        let works = {
            let mut query = tx.prepare("SELECT id FROM works").map_err(db_error)?;
            let rows = query
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(db_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?
        };
        for work in works {
            seed_work(tx, &work)?;
        }
        tx.execute_batch("PRAGMA user_version=4;")
            .map_err(db_error)?;
    }
    for (table, columns) in [
        (
            "conception_defaults",
            vec![
                ("singleton", "INTEGER"),
                ("revision", "INTEGER"),
                ("sections", "TEXT"),
            ],
        ),
        (
            "conception_work_state",
            vec![("work_id", "TEXT"), ("revision", "INTEGER")],
        ),
        (
            "conception_sections",
            vec![
                ("id", "TEXT"),
                ("work_id", "TEXT"),
                ("name", "TEXT"),
                ("hidden", "INTEGER"),
                ("position", "INTEGER"),
            ],
        ),
        (
            "conception_records",
            vec![
                ("id", "TEXT"),
                ("work_id", "TEXT"),
                ("content_id", "TEXT"),
                ("title", "TEXT"),
            ],
        ),
        (
            "conception_references",
            vec![
                ("id", "TEXT"),
                ("record_id", "TEXT"),
                ("section_id", "TEXT"),
                ("position", "INTEGER"),
            ],
        ),
    ] {
        schema::validate_columns(tx, table, &columns)?;
    }
    let (revision, payload): (i64, String) = tx
        .query_row(
            "SELECT revision,sections FROM conception_defaults WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    if revision < 0 {
        return Err("新作品分区默认值版本无效，原库未修改。".into());
    }
    validate_sections(
        &serde_json::from_str::<Vec<ConceptionSection>>(&payload).map_err(db_error)?,
    )?;
    let invalid: i64 = tx.query_row("SELECT
        (SELECT count(*) FROM works w WHERE NOT EXISTS(SELECT 1 FROM conception_work_state s WHERE s.work_id=w.id AND typeof(s.revision)='integer' AND s.revision>=0)) +
        (SELECT count(*) FROM conception_sections WHERE typeof(id)!='text' OR id='' OR typeof(name)!='text' OR trim(name)='' OR hidden NOT IN (0,1) OR typeof(position)!='integer' OR position<0) +
        (SELECT count(*) FROM (SELECT work_id,position FROM conception_sections GROUP BY work_id,position HAVING count(*)>1)) +
        (SELECT count(*) FROM conception_records r WHERE typeof(r.id)!='text' OR r.id='' OR typeof(r.title)!='text' OR EXISTS(SELECT 1 FROM chapters c WHERE c.content_id=r.content_id OR c.id=r.id)) +
        (SELECT count(*) FROM conception_references x JOIN conception_records r ON r.id=x.record_id JOIN conception_sections s ON s.id=x.section_id WHERE r.work_id!=s.work_id OR typeof(x.position)!='integer' OR x.position<0) +
        (SELECT count(*) FROM (SELECT section_id,position FROM conception_references GROUP BY section_id,position HAVING count(*)>1))", [], |r|r.get(0)).map_err(db_error)?;
    let foreign_keys = tx
        .prepare("PRAGMA foreign_key_check")
        .map_err(db_error)?
        .exists([])
        .map_err(db_error)?;
    if invalid != 0 || foreign_keys {
        return Err("构思记录或分区关联无法确认，原库未修改。".into());
    }
    Ok(())
}
pub(super) fn seed_work(tx: &Transaction<'_>, work: &str) -> Result<()> {
    let payload: String = tx
        .query_row(
            "SELECT sections FROM conception_defaults WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let defaults: Vec<ConceptionSection> = serde_json::from_str(&payload).map_err(db_error)?;
    validate_sections(&defaults)?;
    tx.execute("INSERT INTO conception_work_state VALUES(?,0)", [work])
        .map_err(db_error)?;
    for (position, section) in defaults.iter().enumerate() {
        tx.execute(
            "INSERT INTO conception_sections VALUES(?,?,?,?,?)",
            params![
                Uuid::new_v4().to_string(),
                work,
                section.name,
                section.hidden,
                position as i64
            ],
        )
        .map_err(db_error)?;
    }
    Ok(())
}
fn record_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ConceptionRecord> {
    Ok(ConceptionRecord {
        id: r.get(0)?,
        work_id: r.get(1)?,
        content_id: r.get(2)?,
        title: r.get(3)?,
        body: r.get(4)?,
        body_format: r.get(5)?,
        revision: r.get(6)?,
    })
}
impl Library {
    pub fn conception_view(&self, work_id: &str) -> Result<ConceptionView> {
        let (work_title, revision) = self.db.query_row("SELECT w.title,s.revision FROM works w JOIN conception_work_state s ON s.work_id=w.id WHERE w.id=?",[work_id],|r| Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
        let mut query = self.db.prepare("SELECT id,name,hidden FROM conception_sections WHERE work_id=? ORDER BY position,id").map_err(db_error)?;
        let sections = query
            .query_map([work_id], |r| {
                Ok(ConceptionSection {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    hidden: r.get(2)?,
                })
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let mut query = self.db.prepare("SELECT r.id,r.work_id,r.content_id,r.title,t.body,t.body_format,t.revision FROM conception_records r JOIN contents t ON t.id=r.content_id WHERE r.work_id=? ORDER BY r.rowid").map_err(db_error)?;
        let records = query
            .query_map([work_id], record_row)
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let mut query = self.db.prepare("SELECT x.id,x.record_id,x.section_id FROM conception_references x JOIN conception_sections s ON s.id=x.section_id WHERE s.work_id=? ORDER BY s.position,x.position,x.id").map_err(db_error)?;
        let references = query
            .query_map([work_id], |r| {
                Ok(ConceptionReference {
                    id: r.get(0)?,
                    record_id: r.get(1)?,
                    section_id: r.get(2)?,
                })
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(ConceptionView {
            work_id: work_id.into(),
            work_title,
            revision,
            sections,
            records,
            references,
        })
    }
    pub fn conception_record(&self, id: &str) -> Result<ConceptionRecord> {
        self.db.query_row("SELECT r.id,r.work_id,r.content_id,r.title,t.body,t.body_format,t.revision FROM conception_records r JOIN contents t ON t.id=r.content_id WHERE r.id=?",[id],record_row).map_err(db_error)
    }
    pub fn conception_defaults(&self) -> Result<ConceptionDefaults> {
        let (revision, payload): (i64, String) = self
            .db
            .query_row(
                "SELECT revision,sections FROM conception_defaults WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_error)?;
        Ok(ConceptionDefaults {
            revision,
            sections: serde_json::from_str(&payload).map_err(db_error)?,
        })
    }
    pub fn change_conception_defaults(
        &mut self,
        expected_revision: i64,
        sections: &[ConceptionSection],
    ) -> Result<ConceptionDefaults> {
        validate_sections(sections)?;
        let changed = self.db.execute("UPDATE conception_defaults SET sections=?,revision=revision+1 WHERE singleton=1 AND revision=?",params![serde_json::to_string(sections).map_err(db_error)?,expected_revision]).map_err(db_error)?;
        if changed != 1 {
            return Err(
                "新作品默认值已在其他窗口修改。请重新打开设置核对，已有作品未修改。".into(),
            );
        }
        self.conception_defaults()
    }
    pub fn change_conception_sections(
        &mut self,
        work_id: &str,
        expected_revision: i64,
        sections: &[ConceptionSection],
    ) -> Result<ConceptionView> {
        validate_sections(sections)?;
        let tx = self.db.transaction().map_err(db_error)?;
        let changed = tx.execute("UPDATE conception_work_state SET revision=revision+1 WHERE work_id=? AND revision=?",params![work_id,expected_revision]).map_err(db_error)?;
        if changed != 1 {
            return Err("本书分区已在其他窗口修改。请重新打开设置核对，原配置未覆盖。".into());
        }
        let previous = {
            let mut query = tx
                .prepare("SELECT id FROM conception_sections WHERE work_id=?")
                .map_err(db_error)?;
            let rows = query
                .query_map([work_id], |r| r.get::<_, String>(0))
                .map_err(db_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?
        };
        for old in previous {
            if !sections.iter().any(|s| s.id == old) {
                let used: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM conception_references WHERE section_id=?)",
                        [&old],
                        |r| r.get(0),
                    )
                    .map_err(db_error)?;
                if used {
                    return Err("此分区仍有记录引用，请隐藏分区以保留内容和入口。".into());
                }
                tx.execute(
                    "DELETE FROM conception_sections WHERE id=? AND work_id=?",
                    params![old, work_id],
                )
                .map_err(db_error)?;
            }
        }
        for (position, section) in sections.iter().enumerate() {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT work_id FROM conception_sections WHERE id=?",
                    [&section.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if owner.as_deref().is_some_and(|id| id != work_id) {
                return Err("不能将其他作品的分区移到本书，原配置未修改。".into());
            }
            tx.execute("INSERT INTO conception_sections VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,hidden=excluded.hidden,position=excluded.position",params![section.id,work_id,section.name.trim(),section.hidden,position as i64]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        self.conception_view(work_id)
    }
    pub fn create_conception(
        &mut self,
        work_id: &str,
        section_id: &str,
    ) -> Result<ConceptionRecord> {
        let record = Uuid::new_v4().to_string();
        let content = Uuid::new_v4().to_string();
        let tx = self.db.transaction().map_err(db_error)?;
        check_section(&tx, work_id, section_id)?;
        tx.execute(
            "INSERT INTO contents(id,body,revision) VALUES(?,'',0)",
            [&content],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO conception_records VALUES(?,?,?,'')",
            params![record, work_id, content],
        )
        .map_err(db_error)?;
        insert_reference(&tx, &record, section_id)?;
        tx.commit().map_err(db_error)?;
        self.conception_record(&record)
    }
    pub fn reference_conception(
        &mut self,
        work_id: &str,
        record_id: &str,
        section_id: &str,
    ) -> Result<ConceptionView> {
        let tx = self.db.transaction().map_err(db_error)?;
        check_section(&tx, work_id, section_id)?;
        let owner: String = tx
            .query_row(
                "SELECT work_id FROM conception_records WHERE id=?",
                [record_id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if owner != work_id {
            return Err("只能引用本书自己的构思记录。".into());
        }
        insert_reference(&tx, record_id, section_id)?;
        tx.commit().map_err(db_error)?;
        self.conception_view(work_id)
    }
    pub fn save_conception(&mut self, draft: &SaveConception) -> Result<ConceptionRecord> {
        self.validate_body(&draft.body_format, &draft.body, &draft.content_id)?;
        let tx = self.db.transaction().map_err(db_error)?;
        let changed = tx.execute("UPDATE contents SET body=?,body_format=?,revision=revision+1 WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM conception_records r WHERE r.id=? AND r.content_id=contents.id)",params![draft.body,draft.body_format,draft.content_id,draft.expected_revision,draft.id]).map_err(db_error)?;
        if changed != 1 {
            let saved = tx.query_row("SELECT r.id,r.work_id,r.content_id,r.title,t.body,t.body_format,t.revision FROM conception_records r JOIN contents t ON t.id=r.content_id WHERE r.id=? AND r.content_id=?",params![draft.id,draft.content_id],record_row).optional().map_err(db_error)?;
            if let Some(saved) = saved {
                if same_conception(&saved, draft) {
                    return Ok(saved);
                }
            }
            return Err("构思保存未完成：原记录已在其他窗口修改或不再存在。当前输入保留，可从恢复记录另存一份，原记录不会覆盖。".into());
        }
        tx.execute(
            "UPDATE conception_records SET title=? WHERE id=?",
            params![draft.title, draft.id],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        self.conception_record(&draft.id)
    }
}
fn check_section(tx: &Transaction<'_>, work_id: &str, section_id: &str) -> Result<()> {
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conception_sections WHERE id=? AND work_id=?)",
            params![section_id, work_id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("此分区不属于当前作品，原内容未修改。".into());
    }
    Ok(())
}
fn insert_reference(tx: &Transaction<'_>, record: &str, section: &str) -> Result<()> {
    tx.execute("INSERT INTO conception_references(id,record_id,section_id,position) SELECT ?,?,?,coalesce(max(position)+1,0) FROM conception_references WHERE section_id=? ON CONFLICT(record_id,section_id) DO NOTHING",params![Uuid::new_v4().to_string(),record,section,section]).map_err(db_error)?;
    Ok(())
}
fn same_conception(current: &ConceptionRecord, draft: &SaveConception) -> bool {
    current.id == draft.id
        && current.content_id == draft.content_id
        && current.title == draft.title
        && current.body == draft.body
        && current.body_format == draft.body_format
}

pub(super) mod recovery;
#[cfg(test)]
mod tests;
