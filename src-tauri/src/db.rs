//! SQLite access.  PROJECT-PLAN.md §7, §10.4
//!
//! The database lives in the OS application-support directory, deliberately
//! NOT inside the project folder — so personal data and the git repository are
//! separated by architecture rather than by remembering a .gitignore (§12.3).

use rusqlite::{types::ValueRef, Connection};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Db {
    pub conn: Mutex<Connection>,
    /// The single pre-migration backup, rolled over each time (§10.4, §12.1).
    pub backup_path: PathBuf,
}

pub fn database_path(app_dir: PathBuf) -> PathBuf {
    app_dir.join("tracker.db")
}

pub fn open(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn value_of(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(_) => Value::Null,
    }
}

#[tauri::command]
pub fn db_query(
    db: tauri::State<'_, Db>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let bound = bind(params)?;
    let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(refs.as_slice(), |row| {
            let mut obj = Map::new();
            for (i, name) in names.iter().enumerate() {
                obj.insert(name.clone(), value_of(row.get_ref(i)?));
            }
            Ok(obj)
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Converts JSON parameters to SQLite values.
///
/// ⚠️ Strings must be bound as themselves: `Value::to_string()` on a string
/// yields its JSON form, quotes included — `ishares` would be stored as
/// `"ishares"`.
fn bind(params: Vec<Value>) -> Result<Vec<Box<dyn rusqlite::ToSql>>, String> {
    params
        .into_iter()
        .map(|p| -> Result<Box<dyn rusqlite::ToSql>, String> {
            Ok(match p {
                Value::Null => Box::new(Option::<i64>::None),
                Value::Bool(b) => Box::new(b),
                Value::Number(n) if n.is_i64() => Box::new(n.as_i64().unwrap()),
                Value::Number(n) => Box::new(n.as_f64().ok_or("number out of range")?),
                Value::String(s) => Box::new(s),
                other => return Err(format!("cannot bind {other} as an SQL parameter")),
            })
        })
        .collect()
}

#[derive(serde::Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// Runs statements in ONE transaction: all or nothing. A fund's contents are
/// saved this way, so a crash midway can never leave half a fund (§10.1).
#[tauri::command]
pub fn db_batch(db: tauri::State<'_, Db>, statements: Vec<Statement>) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    batch(&mut conn, statements)
}

fn batch(conn: &mut Connection, statements: Vec<Statement>) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for s in statements {
        let bound = bind(s.params)?;
        let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();
        tx.prepare_cached(&s.sql)
            .and_then(|mut stmt| stmt.execute(refs.as_slice()))
            .map_err(|e| format!("{e} — in: {}", s.sql))?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Applies pending migrations (§10.4).
#[tauri::command]
pub fn db_migrate(db: tauri::State<'_, Db>, scripts: Vec<String>) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    migrate(&mut conn, &scripts, &db.backup_path)
}

/// Backs up first, then runs every script in ONE transaction — all or nothing.
///
/// No backup on a brand-new database: there is nothing yet to lose. If the
/// backup fails, the migration does not run.
fn migrate(conn: &mut Connection, scripts: &[String], backup_path: &Path) -> Result<(), String> {
    let has_schema: bool = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_version'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
        > 0;
    if has_schema {
        backup(conn, backup_path).map_err(|e| format!("backup before migration failed, nothing changed: {e}"))?;
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for sql in scripts {
        tx.execute_batch(sql).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// A consistent copy of the whole database, WAL included.
fn backup(conn: &Connection, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // VACUUM INTO refuses to overwrite, so write beside it and swap in:
    // the previous backup survives until the new one is complete.
    let partial = path.with_extension("db.partial");
    let _ = std::fs::remove_file(&partial);
    let target = partial.to_str().ok_or("backup path is not valid UTF-8")?;
    conn.execute("VACUUM INTO ?1", [target]).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tracker-db-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn versions(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn.prepare("SELECT version FROM schema_version ORDER BY version").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    const V1: &str = "CREATE TABLE schema_version (version INTEGER NOT NULL);
                      INSERT INTO schema_version VALUES (1);";
    const V2: &str = "CREATE TABLE extra (x INTEGER); INSERT INTO schema_version VALUES (2);";

    #[test]
    fn text_is_stored_as_text_not_as_json() {
        let dir = scratch();
        let mut conn = open(&dir.join("t.db")).unwrap();
        conn.execute_batch("CREATE TABLE t (s TEXT, n REAL, i INTEGER)").unwrap();
        batch(&mut conn, vec![Statement {
            sql: "INSERT INTO t VALUES (?, ?, ?)".into(),
            params: vec![Value::from("ishares"), Value::from(8.46), Value::from(3)],
        }]).unwrap();
        let (s, n, i): (String, f64, i64) =
            conn.query_row("SELECT s, n, i FROM t", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(s, "ishares");
        assert_eq!(n, 8.46);
        assert_eq!(i, 3);
    }

    #[test]
    fn a_batch_is_all_or_nothing() {
        let dir = scratch();
        let mut conn = open(&dir.join("t.db")).unwrap();
        conn.execute_batch("CREATE TABLE t (x INTEGER NOT NULL)").unwrap();
        let ins = |x: Value| Statement { sql: "INSERT INTO t VALUES (?)".into(), params: vec![x] };
        assert!(batch(&mut conn, vec![ins(Value::from(1)), ins(Value::from(2)), ins(Value::Null)]).is_err());
        let n: i64 = conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "the first two rows were rolled back with the third");
    }

    #[test]
    fn structured_values_are_refused_rather_than_stringified() {
        assert!(bind(vec![serde_json::json!({"a": 1})]).is_err());
        assert!(bind(vec![serde_json::json!([1, 2])]).is_err());
    }

    #[test]
    fn fresh_database_needs_no_backup() {
        let dir = scratch();
        let mut conn = open(&dir.join("t.db")).unwrap();
        migrate(&mut conn, &[V1.into()], &dir.join("backups/pre-migration.db")).unwrap();
        assert_eq!(versions(&conn), vec![1]);
        assert!(!dir.join("backups/pre-migration.db").exists());
    }

    #[test]
    fn backup_holds_the_state_before_the_migration() {
        let dir = scratch();
        let backup_path = dir.join("backups/pre-migration.db");
        let mut conn = open(&dir.join("t.db")).unwrap();
        migrate(&mut conn, &[V1.into()], &backup_path).unwrap();
        migrate(&mut conn, &[V2.into()], &backup_path).unwrap();

        assert_eq!(versions(&conn), vec![1, 2]);
        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(versions(&backup), vec![1], "backup is the pre-migration state");
    }

    #[test]
    fn a_failing_batch_changes_nothing_and_the_backup_remains() {
        let dir = scratch();
        let backup_path = dir.join("backups/pre-migration.db");
        let mut conn = open(&dir.join("t.db")).unwrap();
        migrate(&mut conn, &[V1.into()], &backup_path).unwrap();

        let broken = "SELECT * FROM no_such_table;".to_string();
        assert!(migrate(&mut conn, &[V2.into(), broken], &backup_path).is_err());

        assert_eq!(versions(&conn), vec![1], "V2 rolled back with the broken script");
        assert!(backup_path.exists());
    }

    #[test]
    fn backup_rolls_over() {
        let dir = scratch();
        let backup_path = dir.join("backups/pre-migration.db");
        let mut conn = open(&dir.join("t.db")).unwrap();
        migrate(&mut conn, &[V1.into()], &backup_path).unwrap();
        migrate(&mut conn, &[V2.into()], &backup_path).unwrap();
        migrate(&mut conn, &["INSERT INTO schema_version VALUES (3);".into()], &backup_path).unwrap();

        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(versions(&backup), vec![1, 2]);
        assert_eq!(std::fs::read_dir(dir.join("backups")).unwrap().count(), 1, "one backup, not a pile");
    }
}
