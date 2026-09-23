// Personal stock research and portfolio tracker.
// A deliberately thin Rust shell — see PROJECT-PLAN.md §8.
//
// Rust does only what a browser physically cannot:
//   · HTTP with arbitrary headers (browsers forbid origin / sec-fetch-*)
//   · local file and SQLite access (database, diagnostics folder)
//   · legacy .xls parsing (HSBC's format)
//
// Everything else — adapters, validation, the security master, exposure
// calculations, all UI — lives in TypeScript.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod diagnostics;
mod http;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
