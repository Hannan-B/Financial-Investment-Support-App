//! Legacy `.xls` (OLE2) parsing.  PROJECT-PLAN.md §4.2
//!
//! HSBC serves holdings as an OLE2 compound document, not CSV or XLSX.
//! This is the single strongest technical reason for Rust over Swift —
//! `calamine` handles it, and Swift has no mature equivalent.

use calamine::{Reader, Xls};
use std::io::Cursor;

/// Returns the first worksheet as rows of strings.
#[tauri::command]
pub fn parse_xls(bytes_base64: String) -> Result<Vec<Vec<String>>, String> {
    rows(&base64_decode(&bytes_base64)?)
}

pub fn rows(bytes: &[u8]) -> Result<Vec<Vec<String>>, String> {
    let mut workbook =
        Xls::new(Cursor::new(bytes)).map_err(|e| format!("not a valid .xls: {e}"))?;
    let sheet_name = workbook
        .sheet_names()
        .first()
        .ok_or("workbook contains no sheets")?
        .clone();
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("could not read sheet '{sheet_name}': {e}"))?;

    Ok(range
        .rows()
        .map(|row| row.iter().map(|c| c.to_string()).collect())
        .collect())
}

pub(crate) fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut table = [255u8; 256];
    for (i, c) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        .iter()
        .enumerate()
    {
        table[*c as usize] = i as u8;
    }
    let cleaned: Vec<u8> = s.bytes().filter(|b| table[*b as usize] != 255).collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let vals: Vec<u32> = chunk.iter().map(|b| table[*b as usize] as u32).collect();
        let n = vals
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, v)| acc | (v << (18 - 6 * i)));
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FUNDS: [&str; 3] = ["hsbc-hies", "hsbc-hips", "hsbc-hijs"];

    /// The real HSBC holdings files — legacy OLE2, the format that decided
    /// Rust over Swift (§4.2).
    ///
    /// Each decodes to exactly its `.rows.json`, which the TypeScript tests
    /// read in place of calling Rust. Regenerate after replacing a fixture:
    /// `UPDATE_GOLDEN=1 cargo test`
    #[test]
    fn hsbc_fixtures_decode_to_their_golden_rows() {
        for fund in FUNDS {
            let dir = "../src/fetch/fixtures";
            let bytes = std::fs::read(format!("{dir}/{fund}.xls")).expect("fixture missing");
            let decoded = rows(&bytes).expect("should be a valid .xls");
            let golden = format!("{dir}/{fund}.rows.json");

            if std::env::var("UPDATE_GOLDEN").is_ok() {
                std::fs::write(&golden, serde_json::to_string(&decoded).unwrap()).unwrap();
            }
            let expected: Vec<Vec<String>> =
                serde_json::from_str(&std::fs::read_to_string(&golden).expect("golden missing"))
                    .unwrap();
            assert_eq!(decoded, expected, "{fund}: .xls no longer decodes to its golden rows");

            let header = decoded.iter().find(|r| r.iter().any(|c| c == "ISIN")).expect("ISIN column");
            assert!(header.iter().any(|c| c == "Weighting"), "{fund}: Weighting column");
        }
    }

    #[test]
    fn rejects_bytes_that_are_not_xls() {
        assert!(rows(b"<html>Service Unavailable</html>").is_err());
    }
}
