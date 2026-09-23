//! What is kept so a broken source can be fixed.  PROJECT-PLAN.md §10.8
//!
//! ```text
//! <app data>/diagnostics/
//!     failures.log                 one JSON object per line
//!     <source>/last-good.<ext>     the last response that passed validation
//!     <source>/last-failed.<ext>   the last response that failed it
//! ```
//!
//! Files rather than database rows, so an agent can read and diff them
//! directly. Outside the repository, like the database (§12.3) — a Trading 212
//! response contains real holdings.
//!
//! Narrow on purpose: the frontend names a source and which copy, never a path.

use std::io::Write;
use std::path::{Path, PathBuf};

pub struct DiagnosticsDir(pub PathBuf);

#[tauri::command]
pub fn diagnostics_save(
    dir: tauri::State<'_, DiagnosticsDir>,
    source: String,
    which: String,
    extension: String,
    body_base64: String,
) -> Result<String, String> {
    let body = crate::xls::base64_decode(&body_base64)?;
    save(&dir.0, &source, &which, &extension, &body).map(|p| p.display().to_string())
}

#[tauri::command]
pub fn diagnostics_log(dir: tauri::State<'_, DiagnosticsDir>, line: String) -> Result<(), String> {
    append(&dir.0, &line)
}

fn save(root: &Path, source: &str, which: &str, extension: &str, body: &[u8]) -> Result<PathBuf, String> {
    if !is_name(source) {
        return Err(format!("invalid source id: {source:?}"));
    }
    if which != "last-good" && which != "last-failed" {
        return Err(format!("invalid copy: {which:?}"));
    }
    if extension.is_empty() || extension.len() > 5 || !extension.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(format!("invalid extension: {extension:?}"));
    }

    let dir = root.join(source);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // One copy per kind: a previous copy with a different extension (JSON that
    // turned into an HTML error page) is replaced, not left beside it.
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.file_stem().and_then(|s| s.to_str()) == Some(which) {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    let path = dir.join(format!("{which}.{extension}"));
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(path)
}

fn append(root: &Path, line: &str) -> Result<(), String> {
    if line.contains('\n') {
        return Err("a log entry must be a single line".into());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("failures.log"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

/// Lower-case letters, digits, `-` and `_`: no separators, no `..`.
fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tracker-diag-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_one_copy_of_each_kind() {
        let root = scratch();
        save(&root, "ishares", "last-good", "json", b"{}").unwrap();
        save(&root, "ishares", "last-good", "html", b"<html>").unwrap();
        save(&root, "ishares", "last-failed", "json", b"[]").unwrap();

        let mut names: Vec<String> = std::fs::read_dir(root.join("ishares"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec!["last-failed.json", "last-good.html"]);
    }

    #[test]
    fn refuses_anything_that_could_escape_the_folder() {
        let root = scratch();
        for source in ["../x", "a/b", "", ".", "..", "A"] {
            assert!(save(&root, source, "last-good", "json", b"").is_err(), "{source:?}");
        }
        assert!(save(&root, "ok", "../last-good", "json", b"").is_err());
        assert!(save(&root, "ok", "last-good", "json/..", b"").is_err());
    }

    #[test]
    fn log_appends_single_lines() {
        let root = scratch();
        append(&root, r#"{"n":1}"#).unwrap();
        append(&root, r#"{"n":2}"#).unwrap();
        assert!(append(&root, "two\nlines").is_err());
        let log = std::fs::read_to_string(root.join("failures.log")).unwrap();
        assert_eq!(log, "{\"n\":1}\n{\"n\":2}\n");
    }
}
