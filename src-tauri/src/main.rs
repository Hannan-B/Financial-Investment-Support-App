// Personal stock research and portfolio tracker.
// A deliberately thin Rust shell — see PROJECT-PLAN.md §8.
//
// Rust does only what a browser physically cannot:
//   · HTTP with arbitrary headers (browsers forbid origin / sec-fetch-*)
//   · the Trading 212 key, kept in the keychain and never handed to the
//     frontend; only an allow-list of read-only requests can use it
//   · local file and SQLite access (database, diagnostics folder)
//   · legacy .xls parsing (HSBC's format)
//
// Everything else — adapters, validation, the security master, exposure
// calculations, all UI — lives in TypeScript.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod diagnostics;
mod http;
mod t212;
mod xls;

use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let conn = db::open(&db::database_path(dir.clone())).map_err(std::io::Error::other)?;
            app.manage(db::Db {
                conn: Mutex::new(conn),
                backup_path: dir.join("backups").join("pre-migration.db"),
            });
            app.manage(diagnostics::DiagnosticsDir(dir.join("diagnostics")));
            app.manage(t212::Keys(Box::new(t212::Keychain)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http::fetch_url,
            db::db_query,
            db::db_migrate,
            db::db_batch,
            diagnostics::diagnostics_save,
            diagnostics::diagnostics_log,
            xls::parse_xls,
            t212::t212_key_saved,
            t212::t212_key_save,
            t212::t212_key_delete,
            t212::t212_get,
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
