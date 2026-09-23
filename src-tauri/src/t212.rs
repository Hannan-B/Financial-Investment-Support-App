//! Trading 212, read-only.  PROJECT-PLAN.md §8.2, §12.9
//!
//! The key never leaves Rust. The frontend can save one, ask whether one is
//! saved, delete it, and ask for one of a fixed list of read-only requests.
//! It cannot read the key back, and cannot name any other request — so no
//! code path in the app can reach an order endpoint.
//!
//! Three independent layers, strongest first (§8.2):
//!   1. the key is generated WITHOUT the orders permission — T212 refuses
//!   2. IP restriction on the key — T212 refuses from elsewhere
//!   3. this allow-list — the request cannot even be made
//!
//! Trading (Phase 6) will use a second key in a separate module. It does not
//! exist yet, by design (§12.9).

use crate::http::{base64_encode, get, HttpResponse};
use std::collections::HashMap;

const HOST: &str = "https://live.trading212.com";

/// Everything the app may ask Trading 212. GET only. Adding to this list is a
/// deliberate act, reviewed on its own.
const ALLOWED: &[&str] = &[
    "/api/v0/equity/positions",
    "/api/v0/equity/metadata/instruments",
    "/api/v0/equity/account/summary",
];

const SERVICE: &str = "com.investmenttracker.app";
const ACCOUNT: &str = "trading212-read";

/// Where the key is kept. The keychain in the app; memory in tests, so tests
/// never touch the real keychain.
pub trait KeyStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub struct Keychain;

impl KeyStore for Keychain {
    fn get(&self) -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("could not read the keychain: {e}")),
        }
    }
    fn set(&self, value: &str) -> Result<(), String> {
        entry()?.set_password(value).map_err(|e| format!("could not write to the keychain: {e}"))
    }
    fn delete(&self) -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not delete from the keychain: {e}")),
        }
    }
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

pub struct Keys(pub Box<dyn KeyStore>);

#[tauri::command]
pub fn t212_key_saved(keys: tauri::State<'_, Keys>) -> Result<bool, String> {
    Ok(keys.0.get()?.is_some())
}

/// Stores the API key and secret. Checked for shape only — whether T212
/// accepts it is learned from the first request (401 vs 403, §12.9).
#[tauri::command]
pub fn t212_key_save(keys: tauri::State<'_, Keys>, key: String, secret: String) -> Result<(), String> {
    keys.0.set(&credential(&key, &secret)?)
}

#[tauri::command]
pub fn t212_key_delete(keys: tauri::State<'_, Keys>) -> Result<(), String> {
    keys.0.delete()
}

#[tauri::command]
pub async fn t212_get(keys: tauri::State<'_, Keys>, path: String) -> Result<HttpResponse, String> {
    let (url, headers) = request(&path, keys.0.get()?)?;
    get(&url, &headers).await
}

fn credential(key: &str, secret: &str) -> Result<String, String> {
    let (key, secret) = (key.trim(), secret.trim());
    if key.is_empty() || secret.is_empty() {
        return Err("both the API key and the secret are needed".into());
    }
    if key.contains(':') || key.chars().chain(secret.chars()).any(char::is_whitespace) {
        return Err("that does not look like a Trading 212 key and secret".into());
    }
    Ok(format!("{key}:{secret}"))
}

/// The one place a Trading 212 request is built.
fn request(path: &str, credential: Option<String>) -> Result<(String, HashMap<String, String>), String> {
    if !ALLOWED.contains(&path) {
        return Err(format!("not an allowed Trading 212 request: {path}"));
    }
    let credential = credential.ok_or("no Trading 212 key saved")?;
    let mut headers = HashMap::new();
    headers.insert("authorization".into(), format!("Basic {}", base64_encode(credential.as_bytes())));
    Ok((format!("{HOST}{path}"), headers))
}

/// Is this URL Trading 212? `fetch_url` refuses those, so the only road to
/// Trading 212 is through the allow-list above.
pub fn is_trading212(url: &str) -> bool {
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    host == "trading212.com" || host.ends_with(".trading212.com")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Memory(Mutex<Option<String>>);
    impl KeyStore for Memory {
        fn get(&self) -> Result<Option<String>, String> { Ok(self.0.lock().unwrap().clone()) }
        fn set(&self, v: &str) -> Result<(), String> { *self.0.lock().unwrap() = Some(v.into()); Ok(()) }
        fn delete(&self) -> Result<(), String> { *self.0.lock().unwrap() = None; Ok(()) }
    }

    const KEY: Option<&str> = Some("key123:secret456");

    #[test]
    fn allowed_reads_are_built_with_basic_auth() {
        let (url, headers) = request("/api/v0/equity/positions", KEY.map(Into::into)).unwrap();
        assert_eq!(url, "https://live.trading212.com/api/v0/equity/positions");
        assert_eq!(headers["authorization"], format!("Basic {}", base64_encode(b"key123:secret456")));
    }

    #[test]
    fn no_order_endpoint_can_be_reached() {
        for path in [
            "/api/v0/equity/orders",
            "/api/v0/equity/orders/limit",
            "/api/v0/equity/orders/market",
            "/api/v0/equity/orders/stop",
            "/api/v0/equity/orders/stop_limit",
            "/api/v0/equity/orders/123",
            "/api/v0/equity/pies",
            "/api/v0/equity/history/exports",
            "/api/v0/equity/positions/../orders/market",
            "/api/v0/equity/positions?x=/orders",
            "/API/V0/EQUITY/ORDERS/MARKET",
            "",
        ] {
            assert!(request(path, KEY.map(Into::into)).is_err(), "{path} must be refused");
        }
    }

    #[test]
    fn the_allow_list_itself_holds_no_write_or_order_path() {
        for path in ALLOWED {
            assert!(!path.contains("orders") && !path.contains("pies") && !path.contains("exports"), "{path}");
        }
    }

    #[test]
    fn nothing_is_sent_without_a_key() {
        assert_eq!(request("/api/v0/equity/positions", None).unwrap_err(), "no Trading 212 key saved");
    }

    #[test]
    fn fetch_url_cannot_be_used_to_reach_trading212() {
        for url in [
            "https://live.trading212.com/api/v0/equity/orders/market",
            "https://demo.trading212.com/api/v0/equity/positions",
            "https://LIVE.Trading212.com/x",
            "https://user@live.trading212.com:443/x",
            "https://trading212.com",
        ] {
            assert!(is_trading212(url), "{url}");
        }
        for url in ["https://www.ishares.com/x", "https://nottrading212.com/x", "https://trading212.com.evil.example/x"] {
            assert!(!is_trading212(url), "{url}");
        }
    }

    #[test]
    fn keys_are_checked_for_shape_and_never_read_back_raw() {
        let store = Memory(Mutex::new(None));
        assert!(credential("", "s").is_err());
        assert!(credential("k:x", "s").is_err());
        assert!(credential("k", "s s").is_err());
        store.set(&credential(" key123 ", "secret456\n").unwrap()).unwrap();
        assert_eq!(store.get().unwrap().as_deref(), KEY);
        store.delete().unwrap();
        assert_eq!(store.get().unwrap(), None);
    }
}
