use super::*;
use std::io::Cursor;
fn draft(record: &ConceptionRecord, text: &str) -> SaveConception {
    SaveConception {
        id: record.id.clone(),
        content_id: record.content_id.clone(),
        title: "一句话也可以".into(),
        body: text.into(),
        body_format: "plain-text".into(),
        expected_revision: record.revision,
    }
}
fn work(library: &mut Library, title: &str) -> String {
    library.create_work(title).unwrap().chapter.unwrap().work_id
}
fn snapshot(record: &ConceptionRecord, text: &str) -> ConceptionRecoveryDraft {
    ConceptionRecoveryDraft {
        session_id: Uuid::new_v4().to_string(),
        sequence: 1,
        base: record.clone(),
        draft: draft(record, text),
    }
}
#[test]
fn one_record_can_be_written_immediately_referenced_twice_and_reopened_without_becoming_manuscript()
{
    let temp = tempfile::tempdir().unwrap();
    let mut library = Library::open(temp.path(), true).unwrap();
    let work_id = work(&mut library, "从结局开始");
    let before = library.view().unwrap().chapter.unwrap();
    let view = library.conception_view(&work_id).unwrap();
    let first = &view.sections[0].id;
    let second = &view.sections[3].id;
    let record = library.create_conception(&work_id, first).unwrap();
    assert_eq!(record.body, "");
    let text = "最后，她决定留下。\n也许只是此刻的感受。🙂";
    library.save_conception(&draft(&record, text)).unwrap();
    library
        .reference_conception(&work_id, &record.id, second)
        .unwrap();
    library
        .reference_conception(&work_id, &record.id, second)
        .unwrap();
    let edited = library.conception_record(&record.id).unwrap();
    library
        .save_conception(&draft(&edited, "同一份内容，继续写。"))
        .unwrap();
    drop(library);
    let library = Library::open(temp.path(), false).unwrap();
    let restored = library.conception_view(&work_id).unwrap();
    assert_eq!(restored.work_title, "从结局开始");
    assert_eq!(restored.records.len(), 1);
    assert_eq!(restored.references.len(), 2);
    assert!(restored.references.iter().all(|r| r.record_id == record.id));
    assert_eq!(restored.records[0].body, "同一份内容，继续写。");
    assert_eq!(restored.records[0].content_id, record.content_id);
    let writing = library.view().unwrap();
    assert_eq!(writing.chapter.unwrap().body, before.body);
    assert_eq!(writing.entries.len(), 1);
}
#[test]
fn hidden_sections_keep_content_and_can_be_opened_without_unhiding_while_defaults_only_affect_future_works(
) {
    let temp = tempfile::tempdir().unwrap();
    let mut library = Library::open(temp.path(), true).unwrap();
    let a = work(&mut library, "当前书");
    let b = work(&mut library, "另一书");
    let mut view = library.conception_view(&a).unwrap();
    let record = library.create_conception(&a, &view.sections[0].id).unwrap();
    library
        .save_conception(&draft(&record, "隐藏仍保留的内容"))
        .unwrap();
    view.sections[0].hidden = true;
    view.sections[0].name = "我的结局".into();
    view.sections.swap(0, 3);
    library
        .change_conception_sections(&a, view.revision, &view.sections)
        .unwrap();
    let defaults = library.conception_defaults().unwrap();
    let future = vec![ConceptionSection {
        id: "new-candidate".into(),
        name: "随便写写".into(),
        hidden: false,
    }];
    library
        .change_conception_defaults(defaults.revision, &future)
        .unwrap();
    assert!(library
        .change_conception_defaults(defaults.revision, &[])
        .is_err());
    let c = work(&mut library, "未来书");
    drop(library);
    let mut library = Library::open(temp.path(), false).unwrap();
    let current = library.conception_view(&a).unwrap();
    let hidden = current
        .sections
        .iter()
        .find(|s| s.id == view.sections[3].id)
        .unwrap();
    assert!(hidden.hidden);
    assert_eq!(hidden.name, "我的结局");
    assert_eq!(
        library.conception_record(&record.id).unwrap().body,
        "隐藏仍保留的内容"
    );
    assert!(library.conception_view(&a).unwrap().sections[3].hidden);
    assert_eq!(
        library.conception_view(&b).unwrap().sections[0].name,
        "故事核心"
    );
    assert_eq!(library.conception_view(&c).unwrap().sections.len(), 1);
    assert_eq!(
        library.conception_view(&c).unwrap().sections[0].name,
        "随便写写"
    );
    assert_ne!(
        library.conception_view(&c).unwrap().sections[0].id,
        "new-candidate"
    );
    assert!(library
        .change_conception_sections(&a, 0, &current.sections)
        .is_err());
    let mut restored = current.sections;
    restored[3].hidden = false;
    library
        .change_conception_sections(&a, current.revision, &restored)
        .unwrap();
    assert!(!library.conception_view(&a).unwrap().sections[3].hidden);
}
#[test]
fn sections_support_new_candidates_and_empty_defaults_but_cannot_remove_live_references_or_cross_works(
) {
    let temp = tempfile::tempdir().unwrap();
    let mut library = Library::open(temp.path(), true).unwrap();
    let a = work(&mut library, "甲");
    let b = work(&mut library, "乙");
    let mut view = library.conception_view(&a).unwrap();
    let foreign = library.conception_view(&b).unwrap().sections[0].id.clone();
    let record = library.create_conception(&a, &view.sections[0].id).unwrap();
    assert!(library.create_conception(&a, &foreign).is_err());
    assert!(library
        .reference_conception(&b, &record.id, &foreign)
        .is_err());
    assert!(library
        .reference_conception(&a, &record.id, &foreign)
        .is_err());
    assert!(library
        .change_conception_sections(&a, view.revision, &view.sections[1..])
        .is_err());
    assert_eq!(library.conception_view(&a).unwrap().revision, view.revision);
    view.sections.push(ConceptionSection {
        id: foreign,
        name: "污染".into(),
        hidden: false,
    });
    assert!(library
        .change_conception_sections(&a, view.revision, &view.sections)
        .is_err());
    view.sections.pop();
    view.sections.push(ConceptionSection {
        id: Uuid::new_v4().to_string(),
        name: "临时想法".into(),
        hidden: false,
    });
    library
        .change_conception_sections(&a, view.revision, &view.sections)
        .unwrap();
    library.change_conception_defaults(0, &[]).unwrap();
    let c = work(&mut library, "无预设");
    assert!(library.conception_view(&c).unwrap().sections.is_empty());
}
#[test]
fn schema_three_migration_preserves_text_identities_unknown_metadata_and_failed_migration_is_atomic(
) {
    for fail in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let mut library = Library::open(temp.path(), true).unwrap();
        let work_id = work(&mut library, "迁移原书");
        let chapter = library.view().unwrap().chapter.unwrap();
        library
            .save_chapter(&SaveChapter {
                id: chapter.id.clone(),
                content_id: chapter.content_id.clone(),
                title: "原章名".into(),
                body: "原文末句，不能丢。".into(),
                body_format: plain_format(),
                expected_revision: 0,
            })
            .unwrap();
        library.db.execute_batch("DROP TRIGGER conception_reference_work; DROP TABLE conception_references; DROP TABLE conception_records; DROP TABLE conception_sections; DROP TABLE conception_work_state; DROP TABLE conception_defaults; ALTER TABLE contents ADD COLUMN unknown_metadata TEXT DEFAULT '保留未知字段'; PRAGMA user_version=3;").unwrap();
        if fail {
            library
                .db
                .execute_batch("CREATE TABLE conception_sections(collision TEXT);")
                .unwrap();
        }
        drop(library);
        let path = temp.path().join("library.sqlite3");
        let before = fs::read(&path).unwrap();
        let opened = Library::open(temp.path(), false);
        if fail {
            assert!(opened.is_err());
            assert_eq!(fs::read(path).unwrap(), before);
        } else {
            let library = opened.unwrap();
            let saved = library.view().unwrap().chapter.unwrap();
            assert_eq!(saved.content_id, chapter.content_id);
            assert_eq!(saved.title, "原章名");
            assert_eq!(saved.body, "原文末句，不能丢。");
            let metadata: String = library
                .db
                .query_row(
                    "SELECT unknown_metadata FROM contents WHERE id=?",
                    [chapter.content_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(metadata, "保留未知字段");
            assert_eq!(library.conception_view(&work_id).unwrap().sections.len(), 7);
        }
    }
}
#[test]
fn failed_main_write_retains_independent_conception_journal_and_reopens_latest_complete_content() {
    let temp = tempfile::tempdir().unwrap();
    let mut library = Library::open(temp.path(), true).unwrap();
    let work_id = work(&mut library, "恢复");
    let section = library.conception_view(&work_id).unwrap().sections[0]
        .id
        .clone();
    let record = library.create_conception(&work_id, &section).unwrap();
    let mut checkpoint = snapshot(&record, "较早");
    library.checkpoint_conception(&checkpoint).unwrap();
    checkpoint.sequence = 2;
    checkpoint.draft.body = "最后的完整构思🙂".into();
    library.checkpoint_conception(&checkpoint).unwrap();
    library.db.execute_batch("CREATE TRIGGER fail_save BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'controlled main write failure'); END;").unwrap();
    assert!(library.save_conception(&checkpoint.draft).is_err());
    drop(library);
    let mut library = Library::open(temp.path(), false).unwrap();
    assert!(library.list_recovery().unwrap().is_empty());
    assert_eq!(library.conception_record(&record.id).unwrap().body, "");
    let candidates = library.list_conception_recovery(&work_id).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].draft.body, "最后的完整构思🙂");
    assert!(!candidates[0].conflict);
    assert!(library
        .recover_conception(&candidates[0].id, 1, false)
        .is_err());
    library.db.execute_batch("DROP TRIGGER fail_save").unwrap();
    library
        .recover_conception(&candidates[0].id, 2, false)
        .unwrap();
    drop(library);
    let library = Library::open(temp.path(), false).unwrap();
    assert_eq!(
        library.conception_record(&record.id).unwrap().body,
        "最后的完整构思🙂"
    );
    assert!(library
        .list_conception_recovery(&work_id)
        .unwrap()
        .is_empty());
}
#[test]
fn conflicting_recovery_copies_images_to_new_content_and_failure_keeps_original_files_and_journal()
{
    let temp = tempfile::tempdir().unwrap();
    let mut library = Library::open(temp.path(), true).unwrap();
    let work_id = work(&mut library, "图文构思");
    let mut view = library.conception_view(&work_id).unwrap();
    let section = view.sections[0].id.clone();
    let record = library.create_conception(&work_id, &section).unwrap();
    let mut png = Cursor::new(vec![]);
    image::DynamicImage::new_rgb8(4, 4)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let image = library
        .import_image(&record.content_id, "构思图.png", png.get_ref())
        .unwrap();
    let body=serde_json::json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":[{"type":"managedImage","attrs":{"attachmentId":image.id,"alt":"构思图"}},{"type":"paragraph","content":[{"type":"text","text":"图后完整末句。"}]}]}}).to_string();
    let mut checkpoint = snapshot(&record, &body);
    checkpoint.draft.body_format = "wab-rich-v1".into();
    library.checkpoint_conception(&checkpoint).unwrap();
    library
        .save_conception(&draft(&record, "另一窗口当前版本"))
        .unwrap();
    view.sections[0].hidden = true;
    library
        .change_conception_sections(&work_id, view.revision, &view.sections)
        .unwrap();
    let candidate = &library.list_conception_recovery(&work_id).unwrap()[0];
    assert!(candidate.conflict);
    assert!(library
        .recover_conception(&candidate.id, candidate.sequence, false)
        .is_err());
    let files = fs::read_dir(temp.path().join("attachments"))
        .unwrap()
        .count();
    library.db.execute_batch("CREATE TRIGGER fail_copy BEFORE INSERT ON conception_records BEGIN SELECT RAISE(ABORT,'controlled copy failure'); END;").unwrap();
    assert!(library
        .recover_conception(&candidate.id, candidate.sequence, true)
        .is_err());
    assert_eq!(
        fs::read_dir(temp.path().join("attachments"))
            .unwrap()
            .count(),
        files
    );
    assert_eq!(library.list_conception_recovery(&work_id).unwrap().len(), 1);
    library.db.execute_batch("DROP TRIGGER fail_copy").unwrap();
    let copy = library
        .recover_conception(&candidate.id, candidate.sequence, true)
        .unwrap();
    assert_ne!(copy.id, record.id);
    assert_ne!(copy.content_id, record.content_id);
    assert_eq!(copy.work_id, work_id);
    let value: serde_json::Value = serde_json::from_str(&copy.body).unwrap();
    let copied_image = value["doc"]["content"][0]["attrs"]["attachmentId"]
        .as_str()
        .unwrap();
    assert_ne!(copied_image, image.id);
    assert!(library
        .read_image(&copy.content_id, copied_image)
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert!(library.read_image(&copy.content_id, &image.id).is_err());
    assert!(library.read_image(&record.content_id, &image.id).is_ok());
    assert_eq!(
        library.conception_record(&record.id).unwrap().body,
        "另一窗口当前版本"
    );
    assert!(library.conception_view(&work_id).unwrap().sections[0].hidden);
    drop(library);
    let library = Library::open(temp.path(), false).unwrap();
    assert!(library
        .conception_record(&copy.id)
        .unwrap()
        .body
        .contains("图后完整末句。"));
    assert!(library.read_image(&copy.content_id, copied_image).is_ok());
    assert_eq!(library.view().unwrap().entries.len(), 1);
}
#[test]
fn stale_writes_missing_images_and_corrupt_or_reordered_checkpoints_never_replace_current_content()
{
    let temp = tempfile::tempdir().unwrap();
    let mut library = Library::open(temp.path(), true).unwrap();
    let work_id = work(&mut library, "校验");
    let section = library.conception_view(&work_id).unwrap().sections[0]
        .id
        .clone();
    let record = library.create_conception(&work_id, &section).unwrap();
    let first = draft(&record, "当前保存内容");
    library.save_conception(&first).unwrap();
    assert_eq!(library.save_conception(&first).unwrap().revision, 1); // lost receipt can retry safely
    assert!(library
        .save_conception(&draft(&record, "过期窗口"))
        .is_err());
    let mut checkpoint = snapshot(&record, "恢复草稿");
    checkpoint.sequence = 2;
    library.checkpoint_conception(&checkpoint).unwrap();
    checkpoint.sequence = 1;
    assert!(library.checkpoint_conception(&checkpoint).is_err());
    library
        .acknowledge_conception_recovery(&checkpoint.session_id, &record.content_id, 2)
        .unwrap();
    assert_eq!(library.list_conception_recovery(&work_id).unwrap().len(), 1);
    let db = library.conception_journal().unwrap();
    db.execute("UPDATE conception_snapshots SET payload='corrupt'", [])
        .unwrap();
    assert!(library.list_conception_recovery(&work_id).is_err());
    assert_eq!(
        library.conception_record(&record.id).unwrap().body,
        "当前保存内容"
    );
    let rich=serde_json::json!({"format":"write-a-book","version":1,"doc":{"type":"doc","content":[{"type":"managedImage","attrs":{"attachmentId":Uuid::new_v4().to_string()}}]}}).to_string();
    assert!(library
        .save_conception(&SaveConception {
            body: rich,
            body_format: "wab-rich-v1".into(),
            expected_revision: 1,
            ..first
        })
        .is_err());
    assert_eq!(
        library.conception_record(&record.id).unwrap().body,
        "当前保存内容"
    );
}
