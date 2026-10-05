//! Opening a link in the user's own browser.  PROJECT-PLAN.md §6.6
//!
//! News headlines open at the source, in the browser where the user's own
//! logins and subscriptions apply — not inside the app's window. Only web
//! addresses are accepted: a file path, a script or another app's scheme is
//! refused, whatever the page asks for.

use std::process::Command;

fn check(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or("only web addresses (https:// or http://) can be opened")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("not a web address".into());
    }
    Ok(())
}

#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    check(&url)?;
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = Command::new("xdg-open");
    // `open` is given the address as one argument: never interpreted by a shell.
    cmd.arg(&url).spawn().map(|_| ()).map_err(|e| format!("could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn web_addresses_only() {
        assert!(check("https://www.bbc.co.uk/news/business-123").is_ok());
        assert!(check("http://example.com").is_ok());
        assert!(check("HTTPS://WWW.SEC.GOV/Archives/x.htm").is_ok());
        for bad in [
            "file:///etc/passwd", "javascript:alert(1)", "/Applications/Calculator.app",
            "x-apple.systempreferences:", "https://", "https:// bad.example", "ftp://example.com", "",
        ] {
            assert!(check(bad).is_err(), "{bad} must be refused");
        }
    }
}
