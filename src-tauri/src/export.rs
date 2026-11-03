//! Saving the notes export to the Downloads folder.  PROJECT-PLAN.md §12.2,
//! §11.8 step 3.6
//!
//! The files are built in TypeScript; this only writes them, into one new
//! folder. Every name is checked, so nothing can be written outside it, and an
//! earlier export of the same day is never overwritten.

use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(serde::Deserialize)]
pub struct ExportFile {
    pub name: String,
    pub text: String,
}

/// A plain file or folder name: no path, nothing hidden, nothing a system reserves.
fn plain(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}

fn write(base: &Path, folder: &str, files: &[ExportFile]) -> Result<PathBuf, String> {
    if !plain(folder) {
        return Err(format!("not a plain folder name: {folder:?}"));
    }
    if let Some(bad) = files.iter().find(|f| !plain(&f.name)) {
        return Err(format!("not a plain file name: {:?}", bad.name));
    }
    let mut dir = base.join(folder);
    let mut n = 2;
    while dir.exists() {
        dir = base.join(format!("{folder} ({n})"));
        n += 1;
    }
    std::fs::create_dir(&dir).map_err(|e| format!("could not make the folder: {e}"))?;
    for f in files {
        std::fs::write(dir.join(&f.name), &f.text).map_err(|e| format!("could not write {}: {e}", f.name))?;
    }
    Ok(dir)
}

/// Writes the export into a new folder in Downloads; returns where.
#[tauri::command]
pub fn export_save(app: tauri::AppHandle, folder: String, files: Vec<ExportFile>) -> Result<String, String> {
    let base = app.path().download_dir().map_err(|e| format!("no Downloads folder: {e}"))?;
    write(&base, &folder, &files).map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tracker-export-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(name: &str, text: &str) -> ExportFile {
        ExportFile { name: name.into(), text: text.into() }
    }

    #[test]
    fn acceptance_3_6_writes_each_file_into_a_new_folder_and_never_overwrites_an_earlier_export() {
        let base = scratch();
        let files = [file("Contents.md", "# Your notes\n"), file("Shell plc (SHEL).md", "# Shell plc (SHEL)\n")];
        let first = write(&base, "Investment Tracker notes 2026-11-02", &files).unwrap();
        let second = write(&base, "Investment Tracker notes 2026-11-02", &files[..1]).unwrap();

        assert_eq!(std::fs::read_to_string(first.join("Shell plc (SHEL).md")).unwrap(), "# Shell plc (SHEL)\n");
        assert_eq!(second.file_name().unwrap(), "Investment Tracker notes 2026-11-02 (2)");
        assert_eq!(std::fs::read_dir(&first).unwrap().count(), 2, "the first export is untouched");
    }

    #[test]
    fn a_name_that_could_reach_outside_the_folder_is_refused_and_nothing_is_written() {
        let base = scratch();
        for bad in ["../escape.md", "/etc/passwd", "a/b.md", ".hidden", "C:evil", ""] {
            assert!(write(&base, "notes", &[file(bad, "x")]).is_err(), "{bad:?} accepted");
        }
        assert!(write(&base, "../notes", &[file("a.md", "x")]).is_err());
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0);
    }
}
