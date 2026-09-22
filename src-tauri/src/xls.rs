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
    let bytes = base64_decode(&bytes_base64)?;
    let mut workbook = Xls::new(Cursor::new(bytes)).map_err(|e| format!("not a valid .xls: {e}"))?;
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

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
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

    /// The real HSBC holdings file — legacy OLE2, the format that decided
    /// Rust over Swift (§4.2). If this breaks, three of nine funds break.
    #[test]
    fn parses_hsbc_holdings() {
        let bytes = std::fs::read("../src/fetch/fixtures/hsbc-hies.xls")
            .expect("fixture missing");
        let mut wb = Xls::new(Cursor::new(bytes)).expect("should be a valid .xls");
        let name = wb.sheet_names().first().expect("has a sheet").clone();
        let range = wb.worksheet_range(&name).expect("readable sheet");
        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect();

        let header = rows.iter().find(|r| r.iter().any(|c| c == "ISIN"))
            .expect("should have an ISIN column");
        assert!(header.iter().any(|c| c == "Weighting"), "expected a Weighting column");
        assert!(rows.len() > 20, "expected real holdings, got {}", rows.len());

        println!("  sheet: {name}");
        println!("  rows: {}", rows.len());
        println!("  columns: {header:?}");
    }
}
