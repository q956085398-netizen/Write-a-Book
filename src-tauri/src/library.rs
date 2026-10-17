mod attachments;
mod recovery;
mod schema;
mod structure;
pub use attachments::Attachment;
pub use recovery::{RecoveryCandidate, RecoveryDraft};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
pub use structure::{Entry, ResumePosition, StructureChange, Volume};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
const APPLICATION_ID: i64 = 0x57414231;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub id: String,
    pub title: String,
    pub last_entry: Option<ResumePosition>,
    pub structure_revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
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
pub struct SaveChapter {
    pub id: String,
    pub content_id: String,
    pub title: String,
    pub body: String,
    #[serde(default = "plain_format")]
    pub body_format: String,
    pub expected_revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    pub path: String,
    pub works: Vec<Work>,
    pub chapter: Option<Chapter>,
    pub entries: Vec<Entry>,
    pub volumes: Vec<Volume>,
}

fn plain_format() -> String {
    "plain-text".into()
}

pub struct Library {
    root: PathBuf,
    db: Connection,
}

fn db_error(e: impl std::fmt::Display) -> String {
    format!("本地资料库操作未完成：{e}")
}

impl Library {
    // Explicit selection may create a library. Restoring a remembered location never does.
    pub fn open(root: &Path, create: bool) -> Result<Self> {
        if !create && !root.join("library.sqlite3").is_file() {
            return Err(
                "上次的资料库不在原位置。请重新选择原资料库文件夹；尚未创建替代资料库。".into(),
            );
        }
        if create {
            fs::create_dir_all(root).map_err(db_error)?;
        }
        let root = root.canonicalize().map_err(db_error)?;
        let path = root.join("library.sqlite3");
        let existed = path.exists();
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | if create {
                OpenFlags::SQLITE_OPEN_CREATE
            } else {
                OpenFlags::empty()
            };
        let mut db = Connection::open_with_flags(path, flags).map_err(db_error)?;
        db.busy_timeout(Duration::from_secs(2)).map_err(db_error)?;
        let app_id: i64 = db
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(db_error)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(db_error)?;
        if existed && (app_id != APPLICATION_ID || !(1..=3).contains(&version)) {
            return Err("所选文件夹中的数据库不是受支持的写一本书资料库，原文件未修改。".into());
        }
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
            .map_err(db_error)?;
        schema::initialize(&mut db, existed, version)?;
        // Files added by later attachment operations live under this managed boundary.
        fs::create_dir_all(root.join("attachments")).map_err(db_error)?;
        Ok(Self { root, db })
    }

    pub fn view(&self) -> Result<LibraryView> {
        let works = self.read_works()?;
        let active: Option<String> = self
            .db
            .query_row(
                "SELECT chapter_id FROM workspace WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten();
        let chapter = active.map(|id| self.read_chapter(&id)).transpose()?;
        let (entries, volumes) = match &chapter {
            Some(chapter) => (
                self.read_entries(&chapter.work_id)?,
                self.read_volumes(&chapter.work_id)?,
            ),
            None => (vec![], vec![]),
        };
        Ok(LibraryView {
            entries,
            volumes,
            path: self.root.to_string_lossy().into_owned(),
            works,
            chapter,
        })
    }

    fn read_chapter(&self, id: &str) -> Result<Chapter> {
        self.db
            .query_row(
                "SELECT c.id,c.work_id,c.content_id,c.title,t.body,t.revision,t.body_format
             FROM chapters c JOIN contents t ON t.id=c.content_id WHERE c.id=?",
                [id],
                |r| {
                    Ok(Chapter {
                        id: r.get(0)?,
                        work_id: r.get(1)?,
                        content_id: r.get(2)?,
                        title: r.get(3)?,
                        body: r.get(4)?,
                        revision: r.get(5)?,
                        body_format: r.get(6)?,
                    })
                },
            )
            .map_err(db_error)
    }

    pub fn create_work(&mut self, title: &str) -> Result<LibraryView> {
        let title = if title.trim().is_empty() {
            "未命名作品"
        } else {
            title.trim()
        };
        let work = Uuid::new_v4().to_string();
        let chapter = Uuid::new_v4().to_string();
        let content = Uuid::new_v4().to_string();
        let tx = self.db.transaction().map_err(db_error)?;
        tx.execute(
            "INSERT INTO works(id,title) VALUES(?,?)",
            params![work, title],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO contents(id,body,revision) VALUES(?,'',0)",
            [&content],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO chapters(id,work_id,content_id,title,position) VALUES(?,?,?,'第一章',0)",
            params![chapter, work, content],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO work_state(work_id,last_entry_id,structure_revision) VALUES(?,?,0)",
            params![work, chapter],
        )
        .map_err(db_error)?;
        structure::remember(&tx, &chapter)?;
        tx.commit().map_err(db_error)?;
        self.view()
    }

    pub fn select_work(&mut self, id: &str) -> Result<Chapter> {
        let chapter: String = self
            .db
            .query_row(
                "SELECT last_entry_id FROM work_state WHERE work_id=?",
                [id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        self.select_entry(&chapter)?;
        self.read_chapter(&chapter)
    }

    pub fn select_entry(&mut self, id: &str) -> Result<LibraryView> {
        let tx = self.db.transaction().map_err(db_error)?;
        structure::remember(&tx, id)?;
        tx.commit().map_err(db_error)?;
        self.view()
    }

    pub fn save_chapter(&mut self, draft: &SaveChapter) -> Result<Chapter> {
        self.validate_body(&draft.body_format, &draft.body, &draft.content_id)?;
        let tx = self.db.transaction().map_err(db_error)?;
        let changed = tx
            .execute(
                "UPDATE contents SET body=?,body_format=?,revision=revision+1 WHERE id=? AND revision=? AND
             EXISTS(SELECT 1 FROM chapters WHERE id=? AND content_id=contents.id)",
                params![
                    draft.body,
                    draft.body_format,
                    draft.content_id,
                    draft.expected_revision,
                    draft.id
                ],
            )
            .map_err(db_error)?;
        if changed != 1 {
            // The write may have committed before its IPC receipt was lost. Exact matching
            // content is already durable; acknowledge it without replaying or overwriting it.
            let saved: Option<Chapter> = tx.query_row(
                "SELECT c.id,c.work_id,c.content_id,c.title,t.body,t.revision,t.body_format FROM chapters c JOIN contents t ON t.id=c.content_id WHERE c.id=? AND c.content_id=?",
                params![draft.id,draft.content_id], |r| Ok(Chapter { id:r.get(0)?,work_id:r.get(1)?,content_id:r.get(2)?,title:r.get(3)?,body:r.get(4)?,revision:r.get(5)?,body_format:r.get(6)? })
            ).optional().map_err(db_error)?;
            if let Some(saved) = saved {
                if saved.title == draft.title
                    && saved.body == draft.body
                    && saved.body_format == draft.body_format
                {
                    return Ok(saved);
                }
            }
            return Err("保存未完成：此正文已在其他窗口中修改或不再存在。当前输入仍保留；可查看恢复草稿并另存一份，原正文不会被覆盖。".into());
        }
        tx.execute(
            "UPDATE chapters SET title=? WHERE id=?",
            params![draft.title, draft.id],
        )
        .map_err(db_error)?;
        let saved = tx
            .query_row(
                "SELECT c.id,c.work_id,c.content_id,c.title,t.body,t.revision,t.body_format
             FROM chapters c JOIN contents t ON t.id=c.content_id WHERE c.id=?",
                [&draft.id],
                |r| {
                    Ok(Chapter {
                        id: r.get(0)?,
                        work_id: r.get(1)?,
                        content_id: r.get(2)?,
                        title: r.get(3)?,
                        body: r.get(4)?,
                        revision: r.get(5)?,
                        body_format: r.get(6)?,
                    })
                },
            )
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(saved)
    }
}

pub struct Application {
    settings: Connection,
    library: Option<Library>,
}

impl Application {
    pub fn new(config: &Path) -> Result<Self> {
        fs::create_dir_all(config).map_err(db_error)?;
        let settings = Connection::open(config.join("settings.sqlite3")).map_err(db_error)?;
        settings.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(db_error)?;
        Ok(Self {
            settings,
            library: None,
        })
    }
    pub fn restore(&mut self) -> Result<Option<LibraryView>> {
        let path: Option<String> = self
            .settings
            .query_row("SELECT value FROM settings WHERE key='library'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)?;
        match path {
            Some(path) => self.open(Path::new(&path), false).map(Some),
            None => Ok(None),
        }
    }
    pub fn open(&mut self, path: &Path, create: bool) -> Result<LibraryView> {
        let library = Library::open(path, create)?;
        let view = library.view()?;
        self.settings.execute("INSERT INTO settings VALUES('library',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&view.path]).map_err(db_error)?;
        self.library = Some(library);
        Ok(view)
    }
    pub fn library(&mut self) -> Result<&mut Library> {
        self.library
            .as_mut()
            .ok_or_else(|| "请先选择资料库。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn author_can_create_write_reopen_and_continue_with_stable_identities() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let root = tmp.path().join("中文资料库");
        let mut app = Application::new(&config).unwrap();
        assert!(app.restore().unwrap().is_none());
        assert!(app.open(&root, true).unwrap().works.is_empty());
        let view = app.library().unwrap().create_work("").unwrap();
        let work = view.works[0].clone();
        let chapter = view.chapter.unwrap();
        let body = "第一行：你好，世界。\n第二行🙂\n　　中文与 English 123。";
        let draft = SaveChapter {
            id: chapter.id.clone(),
            content_id: chapter.content_id.clone(),
            title: "第一章 雨".into(),
            body: body.into(),
            body_format: plain_format(),
            expected_revision: 0,
        };
        app.library().unwrap().save_chapter(&draft).unwrap();
        drop(app);
        let mut app = Application::new(&config).unwrap();
        let reopened = app.restore().unwrap().unwrap();
        assert_eq!(reopened.works[0].id, work.id);
        let restored = reopened.chapter.unwrap();
        assert_eq!(restored.id, chapter.id);
        assert_eq!(restored.content_id, chapter.content_id);
        assert_eq!(restored.body, body);
        assert_eq!(restored.title, "第一章 雨");
        app.library()
            .unwrap()
            .save_chapter(&SaveChapter {
                body: format!("{body}\n继续写。"),
                expected_revision: 1,
                ..draft
            })
            .unwrap();
        drop(app);
        let text = Application::new(&config)
            .unwrap()
            .restore()
            .unwrap()
            .unwrap()
            .chapter
            .unwrap()
            .body;
        assert!(text.ends_with("继续写。"));
    }
    #[test]
    fn stale_save_cannot_overwrite_other_window_and_failed_transaction_keeps_title() {
        let tmp = tempfile::tempdir().unwrap();
        let mut a = Library::open(tmp.path(), true).unwrap();
        let chapter = a.create_work("同名").unwrap().chapter.unwrap();
        let mut b = Library::open(tmp.path(), false).unwrap();
        let draft = SaveChapter {
            id: chapter.id.clone(),
            content_id: chapter.content_id,
            title: "新标题".into(),
            body: "已保存内容".into(),
            body_format: plain_format(),
            expected_revision: 0,
        };
        a.save_chapter(&draft).unwrap();
        let stale = SaveChapter {
            title: "错误标题".into(),
            body: "过期内容".into(),
            ..draft
        };
        assert!(b.save_chapter(&stale).is_err());
        let saved = b.read_chapter(&chapter.id).unwrap();
        assert_eq!(saved.body, "已保存内容");
        assert_eq!(saved.title, "新标题");
    }
    #[test]
    fn unavailable_library_is_not_silently_recreated_and_selection_failure_keeps_current() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let root = tmp.path().join("library");
        let mut app = Application::new(&config).unwrap();
        app.open(&root, true).unwrap();
        app.library().unwrap().create_work("保留作品").unwrap();
        let foreign = tmp.path().join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("library.sqlite3"), b"not a database").unwrap();
        assert!(app.open(&foreign, true).is_err());
        assert_eq!(
            app.library().unwrap().view().unwrap().works[0].title,
            "保留作品"
        );
        drop(app);
        fs::rename(&root, tmp.path().join("moved")).unwrap();
        assert!(Application::new(&config).unwrap().restore().is_err());
        assert!(!root.exists());
    }
    #[test]
    fn same_titles_remain_distinct_and_selection_survives_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let mut library = Library::open(tmp.path(), true).unwrap();
        let first = library.create_work("暂名").unwrap();
        let second = library.create_work("暂名").unwrap();
        assert_ne!(first.works[0].id, second.works[1].id);
        let selected = library.select_work(&first.works[0].id).unwrap();
        drop(library);
        assert_eq!(
            Library::open(tmp.path(), false)
                .unwrap()
                .view()
                .unwrap()
                .chapter
                .unwrap()
                .id,
            selected.id
        );
    }
}
