mod library;
use library::{Application, Chapter, LibraryView, SaveChapter};
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
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            let application = Application::new(&config).map_err(std::io::Error::other)?;
            app.manage(AppState(Mutex::new(application)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            open_library,
            create_work,
            select_work,
            save_chapter
        ])
        .run(tauri::generate_context!())
        .expect("无法启动写一本书");
}
