use super::*;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read, Write},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntry {
    pub id: String,
    pub content_id: String,
    pub title: String,
    pub volume_title: Option<String>,
    pub volume_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub work_id: String,
    pub title: String,
    pub structure_revision: i64,
    pub chapters: Vec<ExportEntry>,
    pub fragments: Vec<ExportEntry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportScope {
    Current { entry_id: String },
    Selected { entry_ids: Vec<String> },
    Book,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentPlacement {
    pub entry_id: String,
    pub before_entry_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub work_id: String,
    pub expected_structure_revision: i64,
    pub scope: ExportScope,
    pub fragments: Vec<FragmentPlacement>,
    pub format: String,
    pub target: String,
    pub acknowledge_txt_loss: bool,
    pub replace_existing: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReceipt {
    pub path: String,
    pub bytes: usize,
    pub chapter_count: usize,
    pub fragment_count: usize,
    pub image_count: usize,
    pub structure_revision: i64,
    pub content_revisions: Vec<ExportRevision>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRevision {
    pub content_id: String,
    pub revision: i64,
}
struct Part {
    entry: ExportEntry,
    body: String,
    format: String,
}
struct Picture {
    bytes: Vec<u8>,
    extension: &'static str,
    width: u32,
    height: u32,
}

impl Library {
    /// One read transaction fixes both the displayed directory version and the entry identities.
    pub fn manuscript_manifest(&self, work: &str) -> Result<ExportManifest> {
        let tx = self.db.unchecked_transaction().map_err(db_error)?;
        let manifest = self.manuscript_manifest_inner(work)?;
        tx.commit().map_err(db_error)?;
        Ok(manifest)
    }
    fn manuscript_manifest_inner(&self, work: &str) -> Result<ExportManifest> {
        let (title, revision): (String, i64) = self.db.query_row("SELECT w.title,s.structure_revision FROM works w JOIN work_state s ON s.work_id=w.id WHERE w.id=?",[work],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
        let entries = self.read_entries(work)?;
        let volumes = self.read_volumes(work)?;
        let mut root: Vec<(i64, Option<&Volume>, Option<&Entry>)> = volumes
            .iter()
            .map(|v| (v.position, Some(v), None))
            .chain(
                entries
                    .iter()
                    .filter(|e| e.kind == "chapter" && e.volume_id.is_none())
                    .map(|e| (e.position, None, Some(e))),
            )
            .collect();
        root.sort_by_key(|e| e.0);
        if root.windows(2).any(|w| w[0].0 == w[1].0) {
            return Err("目录顺序冲突，尚未导出。".into());
        }
        let make = |e: &Entry, volume: Option<&Volume>| ExportEntry {
            id: e.id.clone(),
            content_id: e.content_id.clone(),
            title: e.title.clone(),
            volume_title: volume.map(|v| v.title.clone()),
            volume_id: volume.map(|v| v.id.clone()),
        };
        let mut chapters = vec![];
        for (_, volume, entry) in root {
            if let Some(e) = entry {
                chapters.push(make(e, None));
            }
            if let Some(v) = volume {
                let children: Vec<_> = entries
                    .iter()
                    .filter(|e| e.kind == "chapter" && e.volume_id.as_deref() == Some(&v.id))
                    .collect();
                if children.windows(2).any(|w| w[0].position == w[1].position) {
                    return Err("卷内顺序冲突，尚未导出。".into());
                }
                chapters.extend(children.into_iter().map(|e| make(e, Some(v))));
            }
        }
        if chapters.len() != entries.iter().filter(|e| e.kind == "chapter").count() {
            return Err("目录归属无效，尚未导出。".into());
        }
        let fragments = entries
            .iter()
            .filter(|e| e.kind == "fragment")
            .map(|e| make(e, None))
            .collect();
        Ok(ExportManifest {
            work_id: work.into(),
            title,
            structure_revision: revision,
            chapters,
            fragments,
        })
    }
    /// No caller-supplied prose or attachment paths cross this boundary.
    pub fn export_manuscript(&self, request: &ExportRequest) -> Result<ExportReceipt> {
        if !matches!(request.format.as_str(), "txt" | "docx") {
            return Err("请选择 Word 或 TXT 格式。".into());
        }
        if request.format == "txt" && !request.acknowledge_txt_loss {
            return Err("TXT 无法保留图片和文字样式，请先确认。".into());
        }
        let target = export_target(&self.root, Path::new(&request.target), &request.format)?;
        let tx = self.db.unchecked_transaction().map_err(db_error)?;
        let manifest = self.manuscript_manifest_inner(&request.work_id)?;
        if manifest.structure_revision != request.expected_structure_revision {
            return Err("目录已变化，请重新打开导出面板并核对范围。".into());
        }
        let selected: Vec<String> = match &request.scope {
            ExportScope::Book => manifest.chapters.iter().map(|e| e.id.clone()).collect(),
            ExportScope::Current { entry_id } => vec![entry_id.clone()],
            ExportScope::Selected { entry_ids } => entry_ids.clone(),
        };
        let selected_set: HashSet<_> = selected.iter().cloned().collect();
        if selected.len() != selected_set.len()
            || selected
                .iter()
                .any(|id| !manifest.chapters.iter().any(|e| &e.id == id))
        {
            return Err("导出章节不属于当前作品目录；片段须主动选择位置。".into());
        }
        let chapters: Vec<_> = manifest
            .chapters
            .iter()
            .filter(|e| selected_set.contains(&e.id))
            .cloned()
            .collect();
        let mut used = HashSet::new();
        for placement in &request.fragments {
            if !used.insert(&placement.entry_id)
                || !manifest
                    .fragments
                    .iter()
                    .any(|e| e.id == placement.entry_id)
                || placement
                    .before_entry_id
                    .as_ref()
                    .is_some_and(|id| !selected_set.contains(id))
            {
                return Err("片段选择或插入位置无效，请重新核对。".into());
            }
        }
        let mut ordered = vec![];
        for chapter in &chapters {
            for p in request
                .fragments
                .iter()
                .filter(|p| p.before_entry_id.as_deref() == Some(chapter.id.as_str()))
            {
                let mut fragment = manifest
                    .fragments
                    .iter()
                    .find(|e| e.id == p.entry_id)
                    .unwrap()
                    .clone();
                // A temporary output placement belongs inside the anchor chapter's volume.
                fragment.volume_id = chapter.volume_id.clone();
                fragment.volume_title = chapter.volume_title.clone();
                ordered.push((fragment, true));
            }
            ordered.push((chapter.clone(), false));
        }
        for p in request
            .fragments
            .iter()
            .filter(|p| p.before_entry_id.is_none())
        {
            ordered.push((
                manifest
                    .fragments
                    .iter()
                    .find(|e| e.id == p.entry_id)
                    .unwrap()
                    .clone(),
                true,
            ));
        }
        if ordered.is_empty() {
            return Err("请至少选择一个章节或正文片段。".into());
        }
        let mut parts = vec![];
        let mut revisions = vec![];
        let mut pictures = HashMap::new();
        for (entry, _fragment) in ordered {
            let saved = self.read_chapter(&entry.id)?;
            if saved.work_id != request.work_id || saved.content_id != entry.content_id {
                return Err("内容身份或作品归属变化，尚未导出。".into());
            }
            if saved.body_format == "wab-rich-v1" {
                let doc = parse_rich(&saved.body)?;
                validate_node(&doc, "", 0)?;
                self.collect_export_pictures(&doc, &entry.content_id, &mut pictures)?;
            } else if saved.body_format != "plain-text" {
                return Err("正文格式不受支持，尚未导出。".into());
            }
            revisions.push(ExportRevision {
                content_id: entry.content_id.clone(),
                revision: saved.revision,
            });
            parts.push(Part {
                entry,
                body: saved.body,
                format: saved.body_format,
            });
        }
        // All referenced bytes are now in memory. No later reads can mix snapshot versions.
        tx.commit().map_err(db_error)?;
        let bytes = if request.format == "txt" {
            render_txt(&parts)?.into_bytes()
        } else {
            render_docx(&parts, &pictures)?
        };
        atomic_output(&target, &bytes, request.replace_existing)?;
        Ok(ExportReceipt {
            path: target.to_string_lossy().into_owned(),
            bytes: bytes.len(),
            chapter_count: chapters.len(),
            fragment_count: request.fragments.len(),
            image_count: pictures.len(),
            structure_revision: manifest.structure_revision,
            content_revisions: revisions,
        })
    }
    fn collect_export_pictures(
        &self,
        node: &Value,
        content: &str,
        pictures: &mut HashMap<String, Picture>,
    ) -> Result<()> {
        if node["type"] == "managedImage" {
            let id = node["attrs"]["attachmentId"]
                .as_str()
                .ok_or("图片身份缺失。")?;
            // Validate ownership even when the same id was encountered in another entry.
            let (path, mime, size) = self.attachment_file(content, id)?;
            if !pictures.contains_key(id) {
                let mut bytes = Vec::new();
                fs::File::open(path)
                    .map_err(db_error)?
                    .take(20 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(db_error)?;
                if bytes.len() != size {
                    return Err("图片读取不完整，尚未导出。".into());
                }
                let format = image::guess_format(&bytes).map_err(db_error)?;
                let expected = match mime.as_str() {
                    "image/png" => image::ImageFormat::Png,
                    "image/jpeg" => image::ImageFormat::Jpeg,
                    "image/gif" => image::ImageFormat::Gif,
                    "image/webp" => image::ImageFormat::WebP,
                    _ => return Err("不支持此图片。".into()),
                };
                if format != expected {
                    return Err("图片内容与记录格式不符。".into());
                }
                let mut reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(12000);
                limits.max_image_height = Some(12000);
                limits.max_alloc = Some(128 * 1024 * 1024);
                reader.limits(limits);
                let image = reader.decode().map_err(db_error)?;
                let (bytes, extension) = match format {
                    image::ImageFormat::Png => (bytes, "png"),
                    image::ImageFormat::Jpeg => (bytes, "jpeg"),
                    image::ImageFormat::Gif => (bytes, "gif"),
                    image::ImageFormat::WebP => {
                        let mut out = Cursor::new(vec![]);
                        image
                            .write_to(&mut out, image::ImageFormat::Png)
                            .map_err(db_error)?;
                        (out.into_inner(), "png")
                    }
                    _ => return Err("不支持此图片。".into()),
                };
                pictures.insert(
                    id.into(),
                    Picture {
                        bytes,
                        extension,
                        width: image.width(),
                        height: image.height(),
                    },
                );
            }
        }
        if let Some(children) = node["content"].as_array() {
            for child in children {
                self.collect_export_pictures(child, content, pictures)?;
            }
        }
        Ok(())
    }
}
fn parse_rich(body: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(body).map_err(db_error)?;
    if value.as_object().is_none_or(|o| {
        o.keys()
            .any(|k| !matches!(k.as_str(), "format" | "version" | "doc"))
    }) || value["format"] != "write-a-book"
        || value["version"] != 1
        || value["doc"]["type"] != "doc"
    {
        return Err("图文版本或数据不受支持，尚未导出。".into());
    }
    Ok(value["doc"].clone())
}
fn validate_node(node: &Value, parent: &str, depth: usize) -> Result<()> {
    let fail = || "图文含不支持的结构或格式，尚未导出。".to_string();
    if depth > 64 {
        return Err(fail());
    }
    let obj = node.as_object().ok_or_else(fail)?;
    if obj
        .keys()
        .any(|k| !matches!(k.as_str(), "type" | "attrs" | "content" | "marks" | "text"))
    {
        return Err(fail());
    }
    let kind = node["type"].as_str().ok_or_else(fail)?;
    let block = matches!(
        kind,
        "paragraph" | "heading" | "bulletList" | "orderedList" | "blockquote" | "managedImage"
    );
    let allowed = match parent {
        "" => kind == "doc",
        "doc" | "blockquote" => block,
        "listItem" => block,
        "bulletList" | "orderedList" => kind == "listItem",
        "paragraph" | "heading" => matches!(kind, "text" | "hardBreak"),
        _ => false,
    };
    if !allowed {
        return Err(fail());
    }
    let attrs: HashSet<&str> = match kind {
        "heading" => ["level"].into_iter().collect(),
        "orderedList" => ["start", "type"].into_iter().collect(),
        "managedImage" => ["attachmentId", "alt"].into_iter().collect(),
        _ => HashSet::new(),
    };
    if let Some(raw) = node.get("attrs") {
        if raw
            .as_object()
            .is_none_or(|a| a.keys().any(|k| !attrs.contains(k.as_str())))
        {
            return Err(fail());
        }
    }
    if kind == "heading" && !matches!(node["attrs"]["level"].as_u64(), Some(1..=3)) {
        return Err(fail());
    }
    if kind == "orderedList" {
        if node["attrs"]
            .get("start")
            .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0 || n > i32::MAX as u64))
        {
            return Err(fail());
        }
        if node["attrs"]
            .get("type")
            .is_some_and(|v| !v.is_null() && v != "1")
        {
            return Err("暂不支持此有序列表编号样式。".into());
        }
    }
    if matches!(
        kind,
        "listItem" | "orderedList" | "bulletList" | "blockquote"
    ) {
        let children = node["content"].as_array().ok_or_else(fail)?;
        if children.is_empty() || (kind == "listItem" && children[0]["type"] != "paragraph") {
            return Err(fail());
        }
    }
    if kind == "text"
        && (node["text"].as_str().is_none_or(|t| t.is_empty()) || node.get("content").is_some())
    {
        return Err(fail());
    }
    if kind != "text" && node.get("text").is_some() {
        return Err(fail());
    }
    if kind == "managedImage"
        && (node["attrs"]["attachmentId"].as_str().is_none()
            || node["attrs"]["alt"].as_str().is_none())
    {
        return Err(fail());
    }
    if matches!(kind, "text" | "hardBreak" | "managedImage") && node.get("content").is_some() {
        return Err(fail());
    }
    if let Some(marks) = node.get("marks") {
        if kind != "text" && kind != "hardBreak" {
            return Err(fail());
        }
        for mark in marks.as_array().ok_or_else(fail)? {
            let mark_obj = mark.as_object().ok_or_else(fail)?;
            if mark_obj
                .keys()
                .any(|k| !matches!(k.as_str(), "type" | "attrs"))
            {
                return Err(fail());
            }
            let m = mark["type"].as_str().ok_or_else(fail)?;
            if !matches!(m, "bold" | "italic" | "underline" | "link") {
                return Err(fail());
            }
            if let Some(a) = mark.get("attrs") {
                if a.as_object().is_none_or(|o| {
                    o.keys().any(|k| {
                        m != "link" || !matches!(k.as_str(), "href" | "target" | "rel" | "class")
                    })
                }) {
                    return Err(fail());
                }
            }
            if m == "link" {
                let href = mark["attrs"]["href"]
                    .as_str()
                    .ok_or_else(fail)?
                    .to_ascii_lowercase();
                if !href.starts_with("https://")
                    && !href.starts_with("http://")
                    && !href.starts_with("mailto:")
                {
                    return Err(fail());
                }
            }
        }
    }
    if let Some(children) = node.get("content") {
        for child in children.as_array().ok_or_else(fail)? {
            validate_node(child, kind, depth + 1)?;
        }
    }
    Ok(())
}
fn clean_xml(text: &str) -> Result<String> {
    if text.chars().any(|c| {
        !matches!(c, '\t' | '\n' | '\r') && (c < ' ' || c == '\u{fffe}' || c == '\u{ffff}')
    }) {
        return Err("正文含无法写入 Word 的控制字符，尚未导出。".into());
    }
    Ok(text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;"))
}
fn render_txt(parts: &[Part]) -> Result<String> {
    fn text(n: &Value, out: &mut String) {
        let k = n["type"].as_str().unwrap_or("");
        if k == "text" {
            out.push_str(n["text"].as_str().unwrap_or(""));
        } else if k == "hardBreak" {
            out.push('\n');
        }
        if let Some(c) = n["content"].as_array() {
            for child in c {
                text(child, out);
            }
        }
        if matches!(k, "paragraph" | "heading") {
            out.push_str("\r\n");
        }
    }
    let mut out = String::from("\u{feff}");
    let mut volume = None;
    for p in parts {
        if p.entry.volume_id != volume {
            if let Some(v) = &p.entry.volume_title {
                out.push_str(v);
                out.push_str("\r\n\r\n");
            }
            volume = p.entry.volume_id.clone();
        }
        out.push_str(&p.entry.title);
        out.push_str("\r\n");
        if p.format == "plain-text" {
            out.push_str(&p.body.replace("\r\n", "\n").replace('\n', "\r\n"));
            out.push_str("\r\n");
        } else {
            text(&parse_rich(&p.body)?, &mut out);
        }
        out.push_str("\r\n");
    }
    Ok(out)
}
struct Word<'a> {
    body: String,
    rels: Vec<String>,
    pictures: &'a HashMap<String, Picture>,
    image_ids: HashMap<String, usize>,
    drawing: usize,
    numbering: Vec<String>,
}
impl Word<'_> {
    fn paragraph(&mut self, text: &str, style: Option<&str>) -> Result<()> {
        let style = style
            .map(|s| format!("<w:pPr><w:pStyle w:val=\"{s}\"/></w:pPr>"))
            .unwrap_or_default();
        self.body.push_str(&format!(
            "<w:p>{style}<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
            clean_xml(text)?
        ));
        Ok(())
    }
    fn inline(&mut self, n: &Value) -> Result<String> {
        let mut props = String::new();
        let mut href = None;
        if let Some(marks) = n["marks"].as_array() {
            for m in marks {
                match m["type"].as_str().unwrap_or("") {
                    "bold" => props.push_str("<w:b/>"),
                    "italic" => props.push_str("<w:i/>"),
                    "underline" => props.push_str("<w:u w:val=\"single\"/>"),
                    "link" => href = m["attrs"]["href"].as_str(),
                    _ => (),
                }
            }
        }
        let content = if n["type"] == "hardBreak" {
            "<w:br/>".into()
        } else {
            format!(
                "<w:t xml:space=\"preserve\">{}</w:t>",
                clean_xml(n["text"].as_str().unwrap_or(""))?
            )
        };
        let run = format!("<w:r><w:rPr>{props}</w:rPr>{content}</w:r>");
        if let Some(href) = href {
            let id = self.rels.len() + 1;
            self.rels.push(format!("<Relationship Id=\"rId{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",clean_xml(href)?));
            Ok(format!("<w:hyperlink r:id=\"rId{id}\">{run}</w:hyperlink>"))
        } else {
            Ok(run)
        }
    }
    fn block(
        &mut self,
        n: &Value,
        list: Option<(usize, usize)>,
        quote: bool,
        depth: usize,
    ) -> Result<()> {
        let kind = n["type"].as_str().unwrap_or("");
        match kind {
            "paragraph" | "heading" => {
                let mut props = String::new();
                if kind == "heading" {
                    props.push_str(&format!(
                        "<w:pStyle w:val=\"Heading{}\"/>",
                        n["attrs"]["level"].as_u64().unwrap()
                    ));
                }
                if let Some((id, level)) = list {
                    props.push_str(&format!(
                        "<w:numPr><w:ilvl w:val=\"{level}\"/><w:numId w:val=\"{id}\"/></w:numPr>"
                    ));
                }
                if quote {
                    props.push_str("<w:ind w:left=\"480\"/><w:pBdr><w:left w:val=\"single\" w:sz=\"12\" w:space=\"8\" w:color=\"9AA68E\"/></w:pBdr>");
                }
                self.body.push_str(&format!("<w:p><w:pPr>{props}</w:pPr>"));
                if let Some(children) = n["content"].as_array() {
                    for c in children {
                        let inline = self.inline(c)?;
                        self.body.push_str(&inline);
                    }
                }
                self.body.push_str("</w:p>");
            }
            "managedImage" => {
                let id = n["attrs"]["attachmentId"].as_str().unwrap();
                let picture = self.pictures.get(id).ok_or("导出快照缺少图片。")?;
                let rel_id = if let Some(existing) = self.image_ids.get(id) {
                    *existing
                } else {
                    let r = self.rels.len() + 1;
                    self.rels.push(format!("<Relationship Id=\"rId{r}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/{id}.{}\"/>",picture.extension));
                    self.image_ids.insert(id.into(), r);
                    r
                };
                self.drawing += 1;
                let d = self.drawing;
                let scale = (5486400.0 / (picture.width as f64 * 9525.0)).min(1.0);
                let cx = (picture.width as f64 * 9525.0 * scale) as u64;
                let cy = (picture.height as f64 * 9525.0 * scale) as u64;
                let alt = clean_xml(n["attrs"]["alt"].as_str().unwrap_or(""))?;
                self.body.push_str(&format!("<w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{d}\" name=\"图片{d}\" descr=\"{alt}\"/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{d}\" name=\"图片{d}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"rId{rel_id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"));
            }
            "bulletList" | "orderedList" => {
                let id = self.numbering.len() + 1;
                let indent = (depth + 1) * 720;
                let start = n["attrs"]["start"].as_u64().unwrap_or(1);
                let fmt = if kind == "orderedList" {
                    "decimal"
                } else {
                    "bullet"
                };
                let label = if kind == "orderedList" { "%1." } else { "•" };
                self.numbering.push(format!("<w:abstractNum w:abstractNumId=\"{id}\"><w:multiLevelType w:val=\"singleLevel\"/><w:lvl w:ilvl=\"0\"><w:start w:val=\"{start}\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{label}\"/><w:pPr><w:tabs><w:tab w:val=\"num\" w:pos=\"{indent}\"/></w:tabs><w:ind w:left=\"{indent}\" w:hanging=\"360\"/></w:pPr></w:lvl></w:abstractNum>"));
                if let Some(items) = n["content"].as_array() {
                    for item in items {
                        self.block(item, Some((id, 0)), quote, depth + 1)?;
                    }
                }
            }
            "doc" | "blockquote" | "listItem" => {
                if let Some(children) = n["content"].as_array() {
                    for (i, c) in children.iter().enumerate() {
                        self.block(
                            c,
                            if i == 0 { list } else { None },
                            quote || kind == "blockquote",
                            depth,
                        )?;
                    }
                }
            }
            _ => return Err("图文包含不支持的节点。".into()),
        }
        Ok(())
    }
}
fn render_docx(parts: &[Part], pictures: &HashMap<String, Picture>) -> Result<Vec<u8>> {
    let mut word = Word {
        body: String::new(),
        rels: vec![],
        pictures,
        image_ids: HashMap::new(),
        drawing: 0,
        numbering: vec![],
    };
    let mut volume = None;
    for p in parts {
        if p.entry.volume_id != volume {
            if let Some(v) = &p.entry.volume_title {
                word.paragraph(v, Some("Title"))?;
            }
            volume = p.entry.volume_id.clone();
        }
        word.paragraph(&p.entry.title, Some("Heading1"))?;
        if p.format == "plain-text" {
            for line in p.body.replace("\r\n", "\n").split('\n') {
                word.paragraph(line, None)?;
            }
        } else {
            word.block(&parse_rich(&p.body)?, None, false, 0)?;
        }
    }
    let doc=format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>{}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr></w:body></w:document>",word.body);
    let next = word.rels.len() + 1;
    word.rels.push(format!("<Relationship Id=\"rId{next}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"));
    word.rels.push(format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>",next+1));
    let rels=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{}</Relationships>",word.rels.join(""));
    let mut styles=String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:eastAsia=\"宋体\"/><w:sz w:val=\"24\"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style>");
    for (name, size) in [
        ("Title", 40),
        ("Heading1", 32),
        ("Heading2", 28),
        ("Heading3", 26),
    ] {
        styles.push_str(&format!("<w:style w:type=\"paragraph\" w:styleId=\"{name}\"><w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val=\"{size}\"/></w:rPr></w:style>"));
    }
    styles.push_str("</w:styles>");
    let numbering_instances: String = (1..=word.numbering.len())
        .map(|id| format!("<w:num w:numId=\"{id}\"><w:abstractNumId w:val=\"{id}\"/></w:num>"))
        .collect();
    let numbering=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">{}</w:numbering>",format!("{}{}",word.numbering.join(""),numbering_instances));
    let types = r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;
    let mut files = vec![
        ("[Content_Types].xml".into(), types.as_bytes().to_vec()),
        ("_rels/.rels".into(), root_rels.as_bytes().to_vec()),
        ("word/document.xml".into(), doc.into_bytes()),
        ("word/styles.xml".into(), styles.into_bytes()),
        ("word/numbering.xml".into(), numbering.into_bytes()),
        ("word/_rels/document.xml.rels".into(), rels.into_bytes()),
    ];
    let mut ids: Vec<_> = pictures.keys().collect();
    ids.sort();
    for id in ids {
        let p = &pictures[id];
        files.push((format!("word/media/{id}.{}", p.extension), p.bytes.clone()));
    }
    zip_stored(files)
}
// A minimal ZIP32 writer: fixed internal names, stored entries, CRC-32, no file IO or extraction.
fn zip_stored(files: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>> {
    fn u16le(out: &mut Vec<u8>, n: u16) {
        out.extend(n.to_le_bytes());
    }
    fn u32le(out: &mut Vec<u8>, n: u32) {
        out.extend(n.to_le_bytes());
    }
    fn crc(bytes: &[u8]) -> u32 {
        let mut c = !0u32;
        for b in bytes {
            c ^= *b as u32;
            for _ in 0..8 {
                c = (c >> 1) ^ if c & 1 != 0 { 0xedb88320 } else { 0 };
            }
        }
        !c
    }
    if files.len() > u16::MAX as usize {
        return Err("导出图片数量超出 ZIP32 上限。".into());
    }
    let mut out = vec![];
    let mut central = vec![];
    for (name, data) in &files {
        let size = u32::try_from(data.len()).map_err(db_error)?;
        let offset = u32::try_from(out.len()).map_err(db_error)?;
        let len = u16::try_from(name.len()).map_err(db_error)?;
        let checksum = crc(data);
        u32le(&mut out, 0x04034b50);
        for n in [20, 0x800, 0, 0, 33] {
            u16le(&mut out, n);
        }
        for n in [checksum, size, size] {
            u32le(&mut out, n);
        }
        u16le(&mut out, len);
        u16le(&mut out, 0);
        out.extend(name.as_bytes());
        out.extend(data);
        u32le(&mut central, 0x02014b50);
        for n in [20, 20, 0x800, 0, 0, 33] {
            u16le(&mut central, n);
        }
        for n in [checksum, size, size] {
            u32le(&mut central, n);
        }
        for n in [len, 0, 0, 0, 0] {
            u16le(&mut central, n);
        }
        u32le(&mut central, 0);
        u32le(&mut central, offset);
        central.extend(name.as_bytes());
    }
    let offset = u32::try_from(out.len()).map_err(db_error)?;
    let size = u32::try_from(central.len()).map_err(db_error)?;
    out.extend(central);
    u32le(&mut out, 0x06054b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, files.len() as u16);
    u16le(&mut out, files.len() as u16);
    u32le(&mut out, size);
    u32le(&mut out, offset);
    u16le(&mut out, 0);
    Ok(out)
}
fn export_target(root: &Path, target: &Path, format: &str) -> Result<PathBuf> {
    // Validate before Win32 UTF-16 conversion: embedded NUL would otherwise truncate
    // the FFI destination and could replace a different, pre-existing file.
    if target.as_os_str().as_encoded_bytes().contains(&0) {
        return Err("导出路径含无效字符。".into());
    }
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("导出文件名无效。")?;
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if device
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|c| c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return Err("请选择普通导出文件名，不能包含设备名、路径控制字符或数据流。".into());
    }
    if !target.is_absolute()
        || target
            .extension()
            .and_then(|e| e.to_str())
            .is_none_or(|e| !e.eq_ignore_ascii_case(format))
    {
        return Err("请选择绝对路径和匹配的 .docx 或 .txt 文件名。".into());
    }
    let name = target.file_name().ok_or("导出文件名无效。")?;
    let parent = target
        .parent()
        .ok_or("导出位置无效。")?
        .canonicalize()
        .map_err(db_error)?;
    let target = parent.join(name);
    if target.starts_with(root) {
        return Err("请导出到资料库以外，避免覆盖数据库或受管附件。".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("导出目标必须是普通文件，不能是链接或目录。".into());
            }
            if target.canonicalize().map_err(db_error)?.starts_with(root) {
                return Err("不能覆盖资料库文件。".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(db_error(error)),
    }
    Ok(target)
}
fn atomic_output(target: &Path, bytes: &[u8], replace: bool) -> Result<()> {
    let temp = target
        .parent()
        .ok_or("导出位置无效。")?
        .join(format!(".wab-export-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(db_error)?;
        file.write_all(bytes)
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(db_error)?;
        drop(file);
        atomic_commit(&temp, target, replace).map_err(|e| {
            if replace {
                db_error(e)
            } else {
                format!("导出未完成，目标可能已存在；已有文件未改动：{e}")
            }
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
#[cfg(not(windows))]
fn atomic_commit(source: &Path, target: &Path, replace: bool) -> std::io::Result<()> {
    if replace {
        fs::rename(source, target)
    } else {
        fs::hard_link(source, target)?;
        let _ = fs::remove_file(source);
        Ok(())
    }
}
#[cfg(windows)]
fn atomic_commit(source: &Path, target: &Path, replace: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // WRITE_THROUGH plus explicit REPLACE_EXISTING only after author confirmation.
    // Without REPLACE_EXISTING, an existing target fails atomically (also on FAT/exFAT).
    let flags = 0x8 | if replace { 0x1 } else { 0 };
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod export_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Library, ExportRequest) {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = Library::open(&dir.path().join("library"), true).unwrap();
        let view = lib.create_work("中文书稿").unwrap();
        let first = view.chapter.unwrap();
        lib.db
            .execute(
                "UPDATE chapters SET title='末章',position=2 WHERE id=?",
                [&first.id],
            )
            .unwrap();
        lib.db
            .execute(
                "UPDATE contents SET body='末章正文' WHERE id=?",
                [&first.content_id],
            )
            .unwrap();
        for (id, kind, pos, volume, title, text) in [
            (
                "chapter-first",
                "chapter",
                0,
                Some("卷甲"),
                "开篇章",
                "中文第一段",
            ),
            (
                "chapter-second",
                "chapter",
                0,
                Some("卷乙"),
                "中篇章",
                "中文第二段",
            ),
            ("fragment", "fragment", 0, None, "主动片段", "选择才导出"),
            (
                "fragment-hidden",
                "fragment",
                1,
                None,
                "未选片段",
                "不能混入",
            ),
        ] {
            let content = format!("content-{id}");
            lib.db
                .execute(
                    "INSERT INTO contents(id,body,revision,body_format) VALUES(?,?,0,'plain-text')",
                    params![content, text],
                )
                .unwrap();
            if let Some(v) = volume {
                lib.db
                    .execute(
                        "INSERT INTO volumes VALUES(?,?,?,?)",
                        params![
                            v,
                            first.work_id,
                            if v == "卷甲" {
                                "同名卷"
                            } else {
                                "同名卷"
                            },
                            if v == "卷甲" { 0 } else { 1 }
                        ],
                    )
                    .unwrap();
            }
            lib.db.execute("INSERT INTO chapters(id,work_id,content_id,title,position,kind,volume_id) VALUES(?,?,?,?,?,?,?)",params![id,first.work_id,content,title,pos,kind,volume]).unwrap();
        }
        let request = ExportRequest {
            work_id: first.work_id,
            expected_structure_revision: 0,
            scope: ExportScope::Book,
            fragments: vec![],
            format: "txt".into(),
            target: dir.path().join("书稿.txt").to_string_lossy().into(),
            acknowledge_txt_loss: true,
            replace_existing: false,
        };
        (dir, lib, request)
    }
    fn rich(nodes: Value) -> String {
        serde_json::json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":nodes}}).to_string()
    }
    fn set_rich(lib: &Library, body: &str) {
        lib.db.execute("UPDATE contents SET body=?,body_format='wab-rich-v1' WHERE id='content-chapter-first'",[body]).unwrap();
    }
    #[test]
    fn directory_order_scopes_identity_and_explicit_fragment_position() {
        let (_dir, lib, mut r) = fixture();
        let manifest = lib.manuscript_manifest(&r.work_id).unwrap();
        assert_eq!(
            manifest
                .chapters
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>()[..2],
            ["chapter-first", "chapter-second"]
        );
        r.scope = ExportScope::Selected {
            entry_ids: vec!["chapter-second".into(), "chapter-first".into()],
        };
        r.fragments = vec![FragmentPlacement {
            entry_id: "fragment".into(),
            before_entry_id: Some("chapter-second".into()),
        }];
        let receipt = lib.export_manuscript(&r).unwrap();
        assert_eq!((receipt.chapter_count, receipt.fragment_count), (2, 1));
        let out = fs::read_to_string(&r.target).unwrap();
        assert!(out.find("开篇章").unwrap() < out.find("主动片段").unwrap());
        assert!(out.find("主动片段").unwrap() < out.find("中篇章").unwrap());
        assert!(!out.contains("末章"));
        assert!(!out.contains("不能混入"));
        assert_eq!(out.matches("同名卷").count(), 2);
        r.target = r.target.replace("书稿", "当前章");
        r.scope = ExportScope::Current {
            entry_id: "chapter-second".into(),
        };
        r.fragments.clear();
        lib.export_manuscript(&r).unwrap();
        let out = fs::read_to_string(&r.target).unwrap();
        assert!(out.contains("中文第二段"));
        assert!(!out.contains("中文第一段"));
    }
    #[test]
    fn stale_foreign_duplicate_and_bad_anchor_reject_without_touching_destination() {
        let (_dir, lib, mut r) = fixture();
        fs::write(&r.target, "保留目标").unwrap();
        r.replace_existing = true;
        r.expected_structure_revision = 1;
        assert!(lib.export_manuscript(&r).is_err());
        r.expected_structure_revision = 0;
        for scope in [
            ExportScope::Current {
                entry_id: "fragment".into(),
            },
            ExportScope::Selected {
                entry_ids: vec!["chapter-first".into(), "chapter-first".into()],
            },
            ExportScope::Selected {
                entry_ids: vec!["other-work-chapter".into()],
            },
        ] {
            r.scope = scope;
            assert!(lib.export_manuscript(&r).is_err());
        }
        r.scope = ExportScope::Book;
        r.fragments = vec![FragmentPlacement {
            entry_id: "fragment".into(),
            before_entry_id: Some("other".into()),
        }];
        assert!(lib.export_manuscript(&r).is_err());
        assert_eq!(fs::read_to_string(&r.target).unwrap(), "保留目标");
    }
    #[test]
    fn target_protection_no_clobber_and_atomic_replace() {
        let (dir, lib, mut r) = fixture();
        fs::write(&r.target, "原有完整文件").unwrap();
        assert!(lib.export_manuscript(&r).is_err());
        assert_eq!(fs::read_to_string(&r.target).unwrap(), "原有完整文件");
        r.replace_existing = true;
        lib.export_manuscript(&r).unwrap();
        assert!(fs::read_to_string(&r.target).unwrap().contains("末章正文"));
        r.target = lib
            .root
            .join("attachments/forbidden.txt")
            .to_string_lossy()
            .into();
        assert!(lib.export_manuscript(&r).is_err());
        assert!(!Path::new(&r.target).exists());
        r.target = dir.path().join("absent/out.txt").to_string_lossy().into();
        assert!(lib.export_manuscript(&r).is_err());
        assert_eq!(
            fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with(".wab-export"))
                .count(),
            0
        );
    }
    #[test]
    fn invalid_native_filenames_never_truncate_or_replace_an_existing_target() {
        let (dir, lib, mut r) = fixture();
        let existing = dir.path().join("existing.txt");
        fs::write(&existing, "必须保留").unwrap();
        r.replace_existing = true;
        r.format = "docx".into();
        for name in [
            "existing.txt\0.docx",
            "existing.txt:stream.docx",
            "NUL.docx",
            "COM1.docx",
            "bad?.docx",
        ] {
            r.target = dir.path().join(name).to_string_lossy().into();
            assert!(lib.export_manuscript(&r).is_err(), "{name:?}");
            assert_eq!(fs::read_to_string(&existing).unwrap(), "必须保留");
        }
    }
    #[test]
    fn txt_confirmation_and_unknown_rich_data_never_report_success() {
        let (_dir, lib, mut r) = fixture();
        r.acknowledge_txt_loss = false;
        assert!(lib.export_manuscript(&r).is_err());
        r.acknowledge_txt_loss = true;
        for node in [
            serde_json::json!({"type":"unknown","content":[]}),
            serde_json::json!({"type":"paragraph","attrs":{"alignment":"center"}}),
            serde_json::json!({"type":"paragraph","content":[{"type":"text","text":"不能丢","marks":[{"type":"strike"}]}]}),
            serde_json::json!({"type":"paragraph","content":[{"type":"text","text":"链接","marks":[{"type":"link","attrs":{"href":"file:///etc/passwd"}}]}]}),
        ] {
            set_rich(&lib, &rich(serde_json::json!([node])));
            assert!(lib.export_manuscript(&r).is_err());
            assert!(!Path::new(&r.target).exists());
        }
    }
    #[test]
    fn missing_and_cross_content_images_fail_including_txt() {
        let (_dir, mut lib, r) = fixture();
        let mut buf = Cursor::new(vec![]);
        image::DynamicImage::new_rgb8(8, 4)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let a = lib
            .import_image("content-chapter-first", "插图.png", &buf.into_inner())
            .unwrap();
        let body = rich(
            serde_json::json!([{"type":"managedImage","attrs":{"attachmentId":a.id,"alt":"插图"}}]),
        );
        lib.db.execute("UPDATE contents SET body=?,body_format='wab-rich-v1' WHERE id='content-chapter-second'",[&body]).unwrap();
        assert!(lib.export_manuscript(&r).is_err());
        lib.db.execute("UPDATE contents SET body='',body_format='plain-text' WHERE id='content-chapter-second'",[]).unwrap();
        set_rich(&lib, &body);
        fs::remove_file(lib.root.join("attachments").join(&a.id)).unwrap();
        assert!(lib.export_manuscript(&r).is_err());
        assert!(!Path::new(&r.target).exists());
    }
    #[cfg(windows)]
    #[test]
    fn locked_windows_target_preserves_original_and_cleans_temp() {
        use std::os::windows::fs::OpenOptionsExt;
        let (dir, lib, mut r) = fixture();
        fs::write(&r.target, "锁定目标保留").unwrap();
        r.replace_existing = true;
        let _held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&r.target)
            .unwrap();
        assert!(lib.export_manuscript(&r).is_err());
        assert_eq!(fs::read_to_string(&r.target).unwrap(), "锁定目标保留");
        assert!(!fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with(".wab-export")));
    }
    #[test]
    fn exports_word_with_chinese_styles_links_lists_images_and_webp_fixture() {
        let (dir, mut lib, mut r) = fixture();
        let mut buf = Cursor::new(vec![]);
        let mut image = image::DynamicImage::new_rgb8(200, 100);
        for x in 0..200 {
            for y in 0..100 {
                use image::GenericImage;
                image.put_pixel(x, y, image::Rgba([x as u8, 120, y as u8, 255]));
            }
        }
        image.write_to(&mut buf, image::ImageFormat::WebP).unwrap();
        let a = lib
            .import_image(
                "content-chapter-first",
                "本地WebP图.webp",
                &buf.into_inner(),
            )
            .unwrap();
        let mut png = Cursor::new(vec![]);
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let second = lib
            .import_image("content-chapter-first", "第二张.png", &png.into_inner())
            .unwrap();
        let body = rich(
            serde_json::json!([{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"中文小标题"}]},{"type":"paragraph","content":[{"type":"text","text":"粗体中文","marks":[{"type":"bold"}]},{"type":"text","text":"斜体与下划线","marks":[{"type":"italic"},{"type":"underline"}]},{"type":"hardBreak"},{"type":"text","text":"官方链接","marks":[{"type":"link","attrs":{"href":"https://example.com/?a=1&b=2","target":"_blank","rel":"noopener noreferrer nofollow","class":null}}]}]},{"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"引用内容"}]}]},{"type":"orderedList","attrs":{"start":3,"type":null},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"第三项"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"嵌套项目"}]}]}]}]}]},{"type":"managedImage","attrs":{"attachmentId":a.id,"alt":"中文插图"}},{"type":"managedImage","attrs":{"attachmentId":second.id,"alt":"第二张图片"}}]),
        );
        set_rich(&lib, &body);
        r.fragments = vec![FragmentPlacement {
            entry_id: "fragment".into(),
            before_entry_id: Some("chapter-second".into()),
        }];
        r.format = "docx".into();
        r.target = dir.path().join("全书图文.docx").to_string_lossy().into();
        let receipt = lib.export_manuscript(&r).unwrap();
        assert_eq!(receipt.image_count, 2);
        let bytes = fs::read(&r.target).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let searchable = String::from_utf8_lossy(&bytes);
        assert!(searchable.contains("粗体中文"));
        assert!(searchable.contains("<w:b/>"));
        assert!(searchable.contains("<w:i/>"));
        assert!(searchable.contains("<w:u "));
        assert!(searchable.contains("<w:start w:val=\"3\""));
        assert!(searchable.contains("w:left=\"1440\""));
        assert!(searchable.contains("word/media/"));
        assert!(searchable.contains(".png"));
        assert!(!searchable.contains("不能混入"));
        if let Ok(folder) = std::env::var("WAB_EXPORT_FIXTURE_DIR") {
            let folder = PathBuf::from(folder);
            fs::create_dir_all(&folder).unwrap();
            fs::copy(&r.target, folder.join("全书图文.docx")).unwrap();
            r.format = "txt".into();
            r.target = folder.join("全书图文.txt").to_string_lossy().into();
            r.replace_existing = true;
            lib.export_manuscript(&r).unwrap();
            r.format = "docx".into();
            r.scope = ExportScope::Selected {
                entry_ids: vec!["chapter-second".into(), "chapter-first".into()],
            };
            r.target = folder.join("选定两章.docx").to_string_lossy().into();
            lib.export_manuscript(&r).unwrap();
            r.scope = ExportScope::Current {
                entry_id: "chapter-second".into(),
            };
            r.fragments.clear();
            r.target = folder.join("当前章.docx").to_string_lossy().into();
            lib.export_manuscript(&r).unwrap();
        }
    }
}
