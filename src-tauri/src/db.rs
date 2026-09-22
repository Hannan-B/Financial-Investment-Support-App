//! SQLite access.  PROJECT-PLAN.md §7, §10.4
//!
//! The database lives in the OS application-support directory, deliberately
//! NOT inside the project folder — so personal data and the git repository are
//! separated by architecture rather than by remembering a .gitignore (§12.3).

use rusqlite::{types::ValueRef, Connection};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

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
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let bound: Vec<Box<dyn rusqlite::ToSql>> = params
        .into_iter()
        .map(|p| -> Box<dyn rusqlite::ToSql> {
            match p {
                Value::Null => Box::new(Option::<i64>::None),
                Value::Bool(b) => Box::new(b),
                Value::Number(n) if n.is_i64() => Box::new(n.as_i64().unwrap()),
                Value::Number(n) => Box::new(n.as_f64().unwrap_or(0.0)),
                other => Box::new(other.to_string()),
            }
        })
        .collect();
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

/// Runs a migration inside a transaction — all or nothing (§10.4).
#[tauri::command]
pub fn db_migrate(db: tauri::State<'_, Db>, sql: String) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(&sql).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
