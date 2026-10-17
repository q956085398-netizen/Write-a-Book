use super::*;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentCharacterCount {
    pub content_id: String,
    pub kind: String,
    pub revision: i64,
    pub count: usize,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkCharacterCounts {
    pub work_id: String,
    pub structure_revision: i64,
    pub contents: Vec<ContentCharacterCount>,
}
// Exactly ECMAScript RegExp \s, matching the existing frontend characterCount.
fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn text_count(text: &str) -> usize {
    text.chars().filter(|c| !whitespace(*c)).count()
}
fn node_count(node: &Value, depth: usize) -> Result<usize> {
    if depth > 64 {
        return Err("图文层级过深，字数暂不可用。".into());
    }
    match node["type"].as_str() {
        Some("text") => Ok(text_count(
            node["text"]
                .as_str()
                .ok_or("文字节点无效，字数暂不可用。")?,
        )),
        Some("managedImage" | "hardBreak") => Ok(0),
        Some(
            "doc" | "paragraph" | "heading" | "bulletList" | "orderedList" | "listItem"
            | "blockquote",
        ) => {
            let mut total = 0;
            if let Some(children) = node.get("content") {
                for child in children
                    .as_array()
                    .ok_or("图文子节点无效，字数暂不可用。")?
                {
                    total += node_count(child, depth + 1)?;
                }
            }
            Ok(total)
        }
        _ => Err("图文包含未知节点，字数暂不可用。".into()),
    }
}
fn body_count(body: &str, format: &str) -> Result<usize> {
    match format {
        "plain-text" => Ok(text_count(body)),
        "wab-rich-v1" => {
            let value: Value =
                serde_json::from_str(body).map_err(|_| "图文损坏，字数暂不可用。")?;
            if value["format"] != "write-a-book"
                || value["version"] != 1
                || value["doc"]["type"] != "doc"
            {
                return Err("图文版本无效，字数暂不可用。".into());
            }
            node_count(&value["doc"], 0)
        }
        _ => Err("未知正文格式，字数暂不可用。".into()),
    }
}
impl Library {
    pub fn character_counts(&self, work_id: &str) -> Result<WorkCharacterCounts> {
        // Deferred read transaction keeps structure, kinds and body revisions in one snapshot.
        let tx = self.db.unchecked_transaction().map_err(db_error)?;
        let structure_revision: i64 = tx
            .query_row(
                "SELECT structure_revision FROM work_state WHERE work_id=?",
                [work_id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let mut contents = Vec::new();
        let mut seen = HashSet::new();
        {
            let mut query = tx.prepare("SELECT c.content_id,c.kind,t.revision,t.body,t.body_format FROM chapters c JOIN contents t ON t.id=c.content_id WHERE c.work_id=? AND c.kind IN ('chapter','fragment') ORDER BY c.content_id").map_err(db_error)?;
            let mut rows = query.query([work_id]).map_err(db_error)?;
            while let Some(row) = rows.next().map_err(db_error)? {
                let content_id: String = row.get(0).map_err(db_error)?;
                if !seen.insert(content_id.clone()) {
                    return Err("正文身份重复，字数暂不可用。".into());
                }
                let body: String = row.get(3).map_err(db_error)?;
                let format: String = row.get(4).map_err(db_error)?;
                contents.push(ContentCharacterCount {
                    content_id,
                    kind: row.get(1).map_err(db_error)?,
                    revision: row.get(2).map_err(db_error)?,
                    count: body_count(&body, &format)?,
                });
            }
        }
        tx.commit().map_err(db_error)?;
        Ok(WorkCharacterCounts {
            work_id: work_id.into(),
            structure_revision,
            contents,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_samples_match_javascript_whitespace_and_code_points() {
        assert_eq!(text_count("中文， A!\n🙂"), 6);
        assert_eq!(text_count("👩‍💻 e\u{301}"), 5);
        assert_eq!(text_count("\u{85}\u{feff}\u{200b}\u{3000}"), 2);
        assert_eq!(text_count("\t\n\r\u{a0}\u{2028}\u{2029}"), 0);
    }
    #[test]
    fn rich_nodes_count_only_text_and_fail_closed() {
        let body = serde_json::json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"中文， A!\n🙂"}]},{"type":"managedImage","attrs":{"alt":"不算我"}}]}}).to_string();
        assert_eq!(body_count(&body, "wab-rich-v1").unwrap(), 6);
        assert!(body_count("{}", "wab-rich-v1").is_err());
        assert!(body_count("x", "future").is_err());
        assert!(node_count(&serde_json::json!({"type":"future","text":"x"}), 0).is_err());
    }
    #[test]
    fn scoped_unique_snapshot_survives_move_compile_edit_undo_and_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("counts.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE work_state(work_id TEXT,structure_revision INTEGER);CREATE TABLE contents(id TEXT,body TEXT,revision INTEGER,body_format TEXT);CREATE TABLE chapters(content_id TEXT,work_id TEXT,kind TEXT,title TEXT,position INTEGER);INSERT INTO work_state VALUES('w',0),('other',0);INSERT INTO contents VALUES('a','中文， A!',1,'plain-text'),('b','片段🙂',0,'plain-text'),('n','不计随记',0,'plain-text'),('x','其他书',0,'plain-text');INSERT INTO chapters VALUES('a','w','chapter','不计标题',0),('b','w','fragment','不计标题',0),('n','w','note','随记',0),('x','other','chapter','别书',0);").unwrap();
        let library = Library {
            root: temp.path().into(),
            db,
        };
        let first = library.character_counts("w").unwrap();
        assert_eq!(
            first.contents.iter().map(|x| x.count).collect::<Vec<_>>(),
            vec![5, 3]
        );
        library.db.execute_batch("UPDATE chapters SET position=9 WHERE content_id='a';UPDATE chapters SET kind='chapter' WHERE content_id='b';UPDATE work_state SET structure_revision=2 WHERE work_id='w';UPDATE contents SET body='增',revision=2 WHERE id='a';").unwrap();
        assert_eq!(library.character_counts("w").unwrap().contents[0].count, 1);
        library
            .db
            .execute_batch("UPDATE contents SET body='中文， A!',revision=3 WHERE id='a';")
            .unwrap();
        let expected = library.character_counts("w").unwrap();
        assert_eq!(expected.contents.len(), 2);
        assert!(expected.contents.iter().all(|x| x.kind == "chapter"));
        drop(library);
        let reopened = Library {
            root: temp.path().into(),
            db: Connection::open(path).unwrap(),
        };
        assert_eq!(reopened.character_counts("w").unwrap(), expected);
        assert!(reopened.character_counts("missing").is_err());
        reopened
            .db
            .execute_batch("INSERT INTO chapters VALUES('a','w','chapter','duplicate',10)")
            .unwrap();
        assert!(reopened.character_counts("w").is_err());
    }
}
