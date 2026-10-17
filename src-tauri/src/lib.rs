mod api_profiles;
mod library;
use api_profiles::{api_list_profiles, api_save_profile, api_test_connection, ApiProfileState};
use library::{
    Application, Attachment, Chapter, LibraryView, RecoveryCandidate, RecoveryDraft, SaveChapter,
};
use serde::Serialize;
use std::{path::Path, sync::Mutex};
use tauri::Manager;

struct AppState(Mutex<Application>);
fn access<T>(
    state: &AppState,
    action: impl FnOnce(&mut Application) -> library::Result<T>,
) -> library::Result<T> {
    let mut application = state
        .0
        .lock()
        .map_err(|_| "资料库暂时无法访问。请保留当前文字后重启。".to_string())?;
    action(&mut application)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    default_path: String,
    library: Option<LibraryView>,
    restore_error: Option<String>,
}

#[tauri::command]
fn bootstrap(app: tauri::AppHandle, state: tauri::State<AppState>) -> library::Result<Bootstrap> {
    let default_path = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("写一本书资料库")
        .to_string_lossy()
        .into_owned();
    let restored = access(&state, |a| a.restore());
    let (library, restore_error) = match restored {
        Ok(value) => (value, None),
        Err(error) => (None, Some(error)),
    };
    Ok(Bootstrap {
        default_path,
        library,
        restore_error,
    })
}
#[tauri::command]
fn open_library(path: String, state: tauri::State<AppState>) -> library::Result<LibraryView> {
    access(&state, |a| a.open(Path::new(&path), true))
}
#[tauri::command]
fn create_work(title: String, state: tauri::State<AppState>) -> library::Result<LibraryView> {
    access(&state, |a| a.library()?.create_work(&title))
}
#[tauri::command]
fn select_work(id: String, state: tauri::State<AppState>) -> library::Result<Chapter> {
    access(&state, |a| a.library()?.select_work(&id))
}
#[tauri::command]
fn save_chapter(draft: SaveChapter, state: tauri::State<AppState>) -> library::Result<Chapter> {
    access(&state, |a| a.library()?.save_chapter(&draft))
}
#[tauri::command]
fn checkpoint_chapter(
    snapshot: RecoveryDraft,
    state: tauri::State<AppState>,
) -> library::Result<()> {
    access(&state, |a| a.library()?.checkpoint_chapter(&snapshot))
}
#[tauri::command]
fn acknowledge_recovery(
    session_id: String,
    content_id: String,
    sequence: i64,
    state: tauri::State<AppState>,
) -> library::Result<()> {
    access(&state, |a| {
        a.library()?
            .acknowledge_recovery(&session_id, &content_id, sequence)
    })
}
#[tauri::command]
fn list_recovery(state: tauri::State<AppState>) -> library::Result<Vec<RecoveryCandidate>> {
    access(&state, |a| a.library()?.list_recovery())
}
#[tauri::command]
fn recover_chapter(
    id: String,
    sequence: i64,
    as_copy: bool,
    state: tauri::State<AppState>,
) -> library::Result<LibraryView> {
    access(&state, |a| {
        a.library()?.recover_chapter(&id, sequence, as_copy)
    })
}
#[tauri::command]
fn import_image(
    content_id: String,
    name: String,
    bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> library::Result<Attachment> {
    access(&state, |a| {
        a.library()?.import_image(&content_id, &name, &bytes)
    })
}
#[tauri::command]
fn read_image(
    content_id: String,
    id: String,
    state: tauri::State<AppState>,
) -> library::Result<String> {
    access(&state, |a| a.library()?.read_image(&content_id, &id))
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            app.manage(ApiProfileState::new(config.clone()));
            let application = Application::new(&config).map_err(std::io::Error::other)?;
            app.manage(AppState(Mutex::new(application)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            open_library,
            create_work,
            select_work,
            save_chapter,
            checkpoint_chapter,
            acknowledge_recovery,
            list_recovery,
            recover_chapter,
            import_image,
            read_image,
            api_list_profiles,
            api_save_profile,
            api_test_connection
        ])
        .run(tauri::generate_context!())
        .expect("无法启动写一本书");
}
