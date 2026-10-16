use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::io::{Cursor, Read, Write};
const MAX_IMAGE: usize = 20 * 1024 * 1024;
#[derive(Serialize)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: usize,
}
impl Library {
    pub(super) fn attachment_dir(&self) -> Result<PathBuf> {
        let dir = self.root.join("attachments");
        let metadata = fs::symlink_metadata(&dir).map_err(db_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("附件目录不可用。".into());
        }
        let canonical = dir.canonicalize().map_err(db_error)?;
        if canonical.parent() != Some(self.root.as_path()) {
            return Err("附件目录超出资料库。".into());
        }
        Ok(canonical)
    }
    pub fn import_image(
        &mut self,
        content_id: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<Attachment> {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE {
            return Err("图片为空或超过 20 MB。".into());
        }
        self.db
            .query_row("SELECT id FROM contents WHERE id=?", [content_id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(db_error)?;
        let format = image::guess_format(bytes)
            .map_err(|_| "请选择 PNG、JPEG、GIF 或 WebP 图片。".to_string())?;
        let mime = match format {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Gif => "image/gif",
            image::ImageFormat::WebP => "image/webp",
            _ => return Err("不支持此图片格式。".into()),
        };
        let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(12000);
        limits.max_image_height = Some(12000);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        reader
            .decode()
            .map_err(|_| "图片损坏或尺寸过大，尚未插入。".to_string())?;
        let id = Uuid::new_v4().to_string();
        let path = self.attachment_dir()?.join(&id);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(db_error)?;
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(db_error(error));
        }
        drop(file);
        let name: String = name.chars().take(200).collect();
        if let Err(error) = self.db.execute(
            "INSERT INTO attachments VALUES(?,?,?,?,?)",
            params![id, content_id, name, mime, bytes.len() as i64],
        ) {
            let _ = fs::remove_file(&path);
            return Err(db_error(error));
        }
        Ok(Attachment {
            id,
            name,
            mime: mime.into(),
            size: bytes.len(),
        })
    }
    pub(super) fn attachment_file(
        &self,
        content_id: &str,
        id: &str,
    ) -> Result<(PathBuf, String, usize)> {
        if Uuid::parse_str(id)
            .map(|u| u.to_string() != id)
            .unwrap_or(true)
        {
            return Err("图片身份无效。".into());
        }
        let (mime, size): (String, i64) = self
            .db
            .query_row(
                "SELECT mime,size FROM attachments WHERE id=? AND content_id=?",
                params![id, content_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "资料库中找不到此图片。".to_string())?;
        if size < 0
            || size > MAX_IMAGE as i64
            || !matches!(
                mime.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            )
        {
            return Err("图片记录无效。".into());
        }
        let dir = self.attachment_dir()?;
        let path = dir.join(id);
        let meta =
            fs::symlink_metadata(&path).map_err(|_| "图片文件缺失，文字仍保留。".to_string())?;
        if meta.file_type().is_symlink()
            || !meta.is_file()
            || meta.len() != size as u64
            || path.canonicalize().map_err(db_error)?.parent() != Some(dir.as_path())
        {
            return Err("图片文件无效。".into());
        }
        Ok((path, mime, size as usize))
    }
    pub fn read_image(&self, content_id: &str, id: &str) -> Result<String> {
        let (path, mime, size) = self.attachment_file(content_id, id)?;
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(db_error)?
            .take(MAX_IMAGE as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(db_error)?;
        if bytes.len() != size {
            return Err("图片读取不完整。".into());
        }
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
    }
    pub(super) fn validate_body(&self, format: &str, body: &str, content_id: &str) -> Result<()> {
        if format == "plain-text" {
            return Ok(());
        }
        if format != "wab-rich-v1" {
            return Err("不支持此正文格式，原内容未修改。".into());
        }
        if body.len() > 16 * 1024 * 1024 {
            return Err("正文超过当前 16 MB 保存上限，请保留草稿。".into());
        }
        let value: Value = serde_json::from_str(body)
            .map_err(|_| "图文内容格式损坏，原内容未修改。".to_string())?;
        if value["format"] != "write-a-book"
            || value["version"] != 1
            || value["doc"]["type"] != "doc"
        {
            return Err("图文版本无效。".into());
        }
        self.validate_node(&value["doc"], content_id, 0)
    }
    fn validate_node(&self, node: &Value, content_id: &str, depth: usize) -> Result<()> {
        if depth > 64 {
            return Err("图文层级过深。".into());
        }
        let kind = node["type"].as_str().ok_or("图文节点缺少类型。")?;
        if !matches!(
            kind,
            "doc"
                | "paragraph"
                | "heading"
                | "text"
                | "hardBreak"
                | "bulletList"
                | "orderedList"
                | "listItem"
                | "blockquote"
                | "managedImage"
        ) {
            return Err("图文含不支持的节点，原内容未修改。".into());
        }
        if kind == "managedImage" {
            self.attachment_file(
                content_id,
                node["attrs"]["attachmentId"]
                    .as_str()
                    .ok_or("图片身份缺失。")?,
            )?;
        }
        if kind == "text" && node["text"].as_str().is_none() {
            return Err("文字节点无效。".into());
        }
        if let Some(marks) = node.get("marks") {
            for mark in marks.as_array().ok_or("格式标记无效。")? {
                if !matches!(
                    mark["type"].as_str(),
                    Some("bold" | "italic" | "underline" | "link")
                ) {
                    return Err("不支持的文字格式。".into());
                }
                if mark["type"] == "link" {
                    let href = mark["attrs"]["href"].as_str().ok_or("链接无效。")?;
                    let scheme = href.to_ascii_lowercase();
                    if !scheme.starts_with("https://")
                        && !scheme.starts_with("http://")
                        && !scheme.starts_with("mailto:")
                    {
                        return Err("链接仅支持 http、https 或邮件地址。".into());
                    }
                }
            }
        }
        if let Some(children) = node.get("content") {
            for child in children.as_array().ok_or("图文子节点无效。")? {
                self.validate_node(child, content_id, depth + 1)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 4)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }
    fn rich(id: &str) -> String {
        serde_json::json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"中文与图片"}]},{"type":"managedImage","attrs":{"attachmentId":id,"alt":"插图"}}]}}).to_string()
    }
    #[test]
    fn imported_image_survives_source_move_save_and_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let source = temp.path().join("source.png");
        fs::write(&source, png()).unwrap();
        let mut library = Library::open(&root, true).unwrap();
        let chapter = library.create_work("图文作品").unwrap().chapter.unwrap();
        let attachment = library
            .import_image(&chapter.content_id, "插图.png", &fs::read(&source).unwrap())
            .unwrap();
        fs::rename(&source, temp.path().join("moved.png")).unwrap();
        let body = rich(&attachment.id);
        library
            .save_chapter(&SaveChapter {
                id: chapter.id.clone(),
                content_id: chapter.content_id.clone(),
                title: chapter.title.clone(),
                body: body.clone(),
                body_format: "wab-rich-v1".into(),
                expected_revision: 0,
            })
            .unwrap();
        drop(library);
        let reopened = Library::open(&root, false).unwrap();
        assert_eq!(reopened.view().unwrap().chapter.unwrap().body, body);
        assert_eq!(
            reopened
                .read_image(&chapter.content_id, &attachment.id)
                .unwrap(),
            format!("data:image/png;base64,{}", STANDARD.encode(png()))
        );
    }
    #[test]
    fn invalid_unknown_cross_content_and_missing_attachments_cannot_overwrite_saved_text() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("图文").unwrap().chapter.unwrap();
        let other = library.create_work("其他").unwrap().chapter.unwrap();
        assert!(library
            .import_image(&chapter.content_id, "bad.png", b"not image")
            .is_err());
        assert!(library
            .import_image("missing-content", "image.png", &png())
            .is_err());
        let attachment = library
            .import_image(&chapter.content_id, "safe.png", &png())
            .unwrap();
        assert!(library
            .read_image(&other.content_id, &attachment.id)
            .is_err());
        assert!(library
            .read_image(&chapter.content_id, "../library.sqlite3")
            .is_err());
        assert!(library
            .read_image(&chapter.content_id, &Uuid::new_v4().to_string())
            .is_err());
        let mut draft = SaveChapter {
            id: chapter.id.clone(),
            content_id: chapter.content_id.clone(),
            title: "原标题".into(),
            body: "原文".into(),
            body_format: "plain-text".into(),
            expected_revision: 0,
        };
        library.save_chapter(&draft).unwrap();
        draft.expected_revision = 1;
        draft.title = "不应保存".into();
        draft.body = rich(&Uuid::new_v4().to_string());
        draft.body_format = "wab-rich-v1".into();
        assert!(library.save_chapter(&draft).is_err());
        fs::remove_file(temp.path().join("attachments").join(&attachment.id)).unwrap();
        draft.body = rich(&attachment.id);
        assert!(library.save_chapter(&draft).is_err());
        let retained = library.read_chapter(&chapter.id).unwrap();
        assert_eq!(retained.body, "原文");
        assert_eq!(retained.title, "原标题");
        assert_eq!(retained.revision, 1);
    }
    #[test]
    fn database_registration_failure_does_not_leave_a_successful_attachment_or_file() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("保存失败").unwrap().chapter.unwrap();
        library.db.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
        assert!(library
            .import_image(&chapter.content_id, "image.png", &png())
            .is_err());
        assert_eq!(
            fs::read_dir(temp.path().join("attachments"))
                .unwrap()
                .count(),
            0
        );
    }
    #[test]
    fn migration_keeps_json_looking_v1_body_and_rolls_back_on_failure() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "PRAGMA application_id=1463894577; PRAGMA user_version=1;
            CREATE TABLE contents(id TEXT PRIMARY KEY,body TEXT NOT NULL,revision INTEGER NOT NULL);
            CREATE TABLE attachments(collision TEXT);",
        )
        .unwrap();
        let body = r#"{"format":"write-a-book","version":1,"doc":{"type":"doc"}}"#;
        db.execute("INSERT INTO contents VALUES('content',?,7)", [body])
            .unwrap();
        drop(db);
        assert!(Library::open(temp.path(), false).is_err());
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(db.prepare("SELECT body_format FROM contents").is_err());
        db.execute("DROP TABLE attachments", []).unwrap();
        drop(db);
        let library = Library::open(temp.path(), false).unwrap();
        assert_eq!(
            library
                .db
                .query_row("SELECT body FROM contents", [], |r| r.get::<_, String>(0))
                .unwrap(),
            body
        );
        assert_eq!(
            library
                .db
                .query_row("SELECT body_format FROM contents", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "plain-text"
        );
        assert_eq!(
            library
                .db
                .query_row("SELECT revision FROM contents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
    }
    #[test]
    fn mixed_case_link_scheme_round_trips_without_changing_case_sensitive_url() {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let chapter = library.create_work("链接").unwrap().chapter.unwrap();
        for (revision, href) in [
            "HTTPS://example.com/CaseSensitive?Token=Aa",
            "MAILTO:Author@Example.com",
        ]
        .iter()
        .enumerate()
        {
            let body=serde_json::json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"链接","marks":[{"type":"link","attrs":{"href":href}}]}]}]}}).to_string();
            let saved = library
                .save_chapter(&SaveChapter {
                    id: chapter.id.clone(),
                    content_id: chapter.content_id.clone(),
                    title: chapter.title.clone(),
                    body: body.clone(),
                    body_format: "wab-rich-v1".into(),
                    expected_revision: revision as i64,
                })
                .unwrap();
            assert_eq!(saved.body, body);
        }
    }
}
