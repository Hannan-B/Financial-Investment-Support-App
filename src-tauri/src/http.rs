//! HTTP with arbitrary headers.  PROJECT-PLAN.md §8, §11.5 step 0.4
//!
//! This exists in Rust rather than the frontend because browsers forbid setting
//! `origin` and `sec-fetch-*`, and Invesco returns 406 without them (§4.2).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct HttpRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    /// Base64 so binary payloads (HSBC's .xls) survive the boundary intact.
    pub body_base64: String,
    pub content_type: String,
}

#[tauri::command]
pub async fn fetch_url(request: HttpRequest) -> Result<HttpResponse, String> {
    // The only road to Trading 212 is t212.rs, with its allow-list (§8.2).
    if crate::t212::is_trading212(&request.url) {
        return Err("Trading 212 is reached only through its read-only allow-list".into());
    }
    get(&request.url, &request.headers).await
}

/// Says what is asking, plainly. Some sites refuse a request with no
/// user-agent at all (stockanalysis: 403); none checked refuses this one.
const USER_AGENT: &str = concat!("InvestmentTracker/", env!("CARGO_PKG_VERSION"), " (personal use)");

pub async fn get(url: &str, headers: &HashMap<String, String>) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;

    Ok(HttpResponse {
        status,
        body_base64: base64_encode(&bytes),
        content_type,
    })
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Calls the real fund sites through the app's own HTTP path. Opt-in, so
    /// ordinary test runs never touch the network:
    /// `cargo test live_fund_sites -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_fund_sites() {
        let urls = [
            "https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v2/get-product-data?component=holdings.all&portfolioId=251394&locale=en_GB&targetSite=ishares-uk&portfolioType=ISHARES_FUND_DATA",
            "https://dng-api.invesco.com/cache/v1/accounts/en_GB/shareclasses/IE000UOXRAM8/holdings/index?idType=isin&loadType=initial",
            "https://www.assetmanagement.hsbc.co.uk/api/v1/download/document/ie000agfzm58/gb/en/holdings",
            "https://etfs.waystone.com/fund/wahed-dow-jones-islamic-world-ucits-etf/?download_holdings=1",
            "https://stockanalysis.com/api/search?q=NVIDIA",
        ];
        let mut failed = vec![];
        for url in urls {
            let res = get(url, &HashMap::new()).await.expect("request failed");
            let size = res.body_base64.len() * 3 / 4;
            println!("{} {:>8} bytes  {}  {}", res.status, size, res.content_type, &url[..60.min(url.len())]);
            if res.status != 200 || size < 1000 { failed.push(url); }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        assert!(failed.is_empty(), "refused: {failed:?}");
    }
}
