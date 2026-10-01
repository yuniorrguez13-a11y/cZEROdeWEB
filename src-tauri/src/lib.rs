// cZEROde desktop shell (DESIGN §2.5): plugins, the vault folder, and the .czd/.czb files the app is
// asked to open (file associations, the command line, a second instance, macOS "Open With").
//
// Open-files protocol with the frontend (app/platform.js onOpenFiles):
//   - every accepted path is added to the fs plugin's runtime scope (that exact file only) and queued;
//   - the main window gets an `open-files` event whose payload is the newly queued paths (string[]);
//   - the frontend drains the queue with `take_open_files` once after load and again on every event,
//     so paths that arrive before the page listens (initial argv, macOS launch) are not lost and none
//     is delivered twice.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State, Url};
use tauri_plugin_fs::FsExt;

// G (phase 2): the czstream protocol and the stream_* commands live in `mod stream;` (DESIGN §5.3).
// Add the module declaration here, register the protocol on the builder and its commands in
// `invoke_handler!` next to `take_open_files`.

/// Event the main window receives when files are queued; payload: the new paths.
const OPEN_FILES_EVENT: &str = "open-files";

/// Extensions the app opens (compared case-insensitively).
const OPEN_EXTENSIONS: [&str; 2] = ["czd", "czb"];

/// Paths queued for the frontend (absolute, already allowed in the fs scope).
#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

fn has_open_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| OPEN_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// One command-line argument as a candidate path: `file://` URLs are converted, relative paths are
/// resolved against `cwd`, options (`-x`, `--x`) are ignored.
fn arg_to_path(arg: &str, cwd: &Path) -> Option<PathBuf> {
    if arg.is_empty() || arg.starts_with('-') {
        return None;
    }
    // Byte comparison: slicing the str at 7 would panic inside a multi-byte character ("фото.czd").
    if arg.len() > 7 && arg.as_bytes()[..7].eq_ignore_ascii_case(b"file://") {
        return Url::parse(arg).ok()?.to_file_path().ok();
    }
    let path = PathBuf::from(arg);
    Some(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

/// The .czd/.czb paths named on a command line (`args[0]` is the executable and is skipped).
/// Only the extension is checked here; `accept_paths` checks that each one is a regular file.
fn paths_from_args<I>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .filter_map(|a| arg_to_path(a.as_ref(), cwd))
        .filter(|p| has_open_extension(p))
        .collect()
}

/// Path string handed to the frontend: canonical, without the Windows `\\?\` prefix when the path
/// fits in a normal drive path (what the fs plugin and the dialogs use).
fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows)
        && let Some(rest) = s.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return rest.to_string();
    }
    s.into_owned()
}

/// Canonicalizes, scopes and queues the openable files among `paths`, then notifies the main window.
fn accept_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    let mut accepted = Vec::new();
    for path in paths {
        if !has_open_extension(&path) {
            continue;
        }
        let Ok(real) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !real.is_file() || !has_open_extension(&real) {
            continue;
        }
        // The fs plugin canonicalizes requested paths before matching, so scope the canonical path.
        let allowed = app
            .try_fs_scope()
            .is_some_and(|scope| scope.allow_file(&real).is_ok());
        if allowed {
            accepted.push(display_path(&real));
        }
    }
    if accepted.is_empty() {
        return;
    }
    if let Ok(mut queue) = app.state::<PendingOpenFiles>().0.lock() {
        for p in &accepted {
            if !queue.contains(p) {
                queue.push(p.clone());
            }
        }
    }
    let _ = app.emit_to("main", OPEN_FILES_EVENT, &accepted);
}

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Drains the queue of files the app was asked to open.
#[tauri::command]
fn take_open_files(pending: State<'_, PendingOpenFiles>) -> Vec<String> {
    pending
        .0
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch (e.g. double-clicking another .czd) forwards its
        // argv here and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            accept_paths(app, paths_from_args(argv, Path::new(&cwd)));
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingOpenFiles::default())
        .invoke_handler(tauri::generate_handler![take_open_files])
        .setup(|app| {
            // <AppData> = {data_dir}/{identifier}: the 2.0 vault lives in vault2/items; the Tauri 1 app's
            // old .czd files are in vault/ (read only, never created here).
            let items = app.path().app_data_dir()?.join("vault2").join("items");
            std::fs::create_dir_all(&items)?;
            // Windows/Linux pass associated files on the command line; macOS uses RunEvent::Opened.
            #[cfg(not(target_os = "macos"))]
            {
                let cwd = std::env::current_dir().unwrap_or_default();
                accept_paths(app.handle(), paths_from_args(std::env::args(), &cwd));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building cZEROde");

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .collect();
            accept_paths(handle, paths);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_keep_only_czd_and_czb() {
        let cwd = if cfg!(windows) {
            PathBuf::from(r"C:\work")
        } else {
            PathBuf::from("/work")
        };
        let got = paths_from_args(
            [
                "app",
                "--flag",
                "a.czd",
                "b.CZB",
                "c.txt",
                "noext",
                "d.czd.txt",
                "",
            ],
            &cwd,
        );
        assert_eq!(got, vec![cwd.join("a.czd"), cwd.join("b.CZB")]);
    }

    #[test]
    fn args_skip_the_executable() {
        assert!(paths_from_args(["/opt/czeroode/x.czd"], Path::new("/")).is_empty());
    }

    #[test]
    fn absolute_args_stay_absolute() {
        let abs = std::env::temp_dir().join("x.czd");
        let got = paths_from_args(
            ["app".to_string(), abs.to_string_lossy().into_owned()],
            Path::new("/elsewhere"),
        );
        assert_eq!(got, vec![abs]);
    }

    #[cfg(not(windows))]
    #[test]
    fn file_urls_become_paths() {
        let got = paths_from_args(["app", "file:///home/bob/My%20File.czd"], Path::new("/"));
        assert_eq!(got, vec![PathBuf::from("/home/bob/My File.czd")]);
    }

    // A multi-byte character across byte 7 must not panic the `file://` check (startup / second launch).
    #[test]
    fn non_ascii_args_do_not_panic() {
        let cwd = Path::new("/w");
        let got = paths_from_args(["app", "фото.czd", "/home/ñandú/x.czd", "файл", "ñ"], cwd);
        assert_eq!(
            got,
            vec![cwd.join("фото.czd"), PathBuf::from("/home/ñandú/x.czd")]
        );
    }

    #[test]
    fn extension_check_is_case_insensitive() {
        assert!(has_open_extension(Path::new("x.CzD")));
        assert!(has_open_extension(Path::new("x.czb")));
        assert!(!has_open_extension(Path::new("x.czdx")));
        assert!(!has_open_extension(Path::new("czd")));
    }

    #[test]
    fn display_path_is_lossless_off_windows() {
        let p = Path::new("/tmp/a b/c.czd");
        if !cfg!(windows) {
            assert_eq!(display_path(p), "/tmp/a b/c.czd");
        }
    }
}
