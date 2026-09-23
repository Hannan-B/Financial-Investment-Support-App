# Financial Investment Support App

A personal desktop tool for researching shares and tracking a portfolio.

It gathers a company's financials, price history, technical indicators, news and
upcoming dates into one place, lets you write notes against those figures, and
keeps them so you can see how both the company and your own thinking changed
over time.

It is an aid to thinking, not an adviser. It shows data and records your
reasoning; it never suggests what to buy or sell.

## Principles

| | |
|---|---|
| **No AI** | Deterministic. Indicators are formulas; reports are templates. |
| **Private** | Local-first. No accounts, no telemetry, nothing phoned home. |
| **No suggestions** | Informs, never advises. Read-only against the broker by default. |
| **Free** | No paid data feeds or subscriptions. |
| **Any market** | Not limited to US listings. |
| **Small** | Under 500 MB of storage after a decade of use. |

## How it is built

A [Tauri](https://tauri.app) desktop app with a deliberately thin Rust layer.
Rust does only what a browser cannot:

- **HTTP with arbitrary headers** — browsers forbid setting `origin` and
  `sec-fetch-*`, which some data sources require
- **SQLite** access
- **Legacy `.xls` parsing** — one fund provider serves OLE2 workbooks

Everything else — data adapters, validation, calculations, all UI — is
TypeScript.

## Where the data comes from

| | |
|---|---|
| Prices, charts | Yahoo Finance |
| US company figures | SEC EDGAR (official filings) |
| UK & European figures, dates, news | stockanalysis.com |
| US ratios and analyst views | Finviz |
| Fund holdings | iShares, Invesco, HSBC, Waystone |
| Exchange rates | European Central Bank |
| Holdings and dividends | Trading 212 |

Technical indicators are **computed locally** rather than read from a website,
so the periods are yours to choose and the working is visible.

## Bad data is refused, not stored

Most of these sources are undocumented and can change without warning. Every
response is validated before anything is written — fund weights must sum to
~100%, row counts must be plausible, dates must be recent, and every category
label must be one the app recognises.

Three outcomes are distinguished:

- **ok** — validated and stored
- **unavailable** — no response (offline, rate-limited). Recorded as absent; the
  snapshot still saves.
- **suspect** — it answered, but the data failed validation. **Rejected. Nothing
  is stored.**

Losing your connection must not discard a refresh. Being given wrong data
always must.

### When a source breaks

Every failure is written down where it can be read later, in the app's data
directory (`~/Library/Application Support/com.investmenttracker.app/`):

| | |
|---|---|
| `diagnostics/failures.log` | One JSON line per failure: source, URL, which check failed, what was expected, what was seen |
| `diagnostics/<source>/last-good.*` | The last response that passed validation |
| `diagnostics/<source>/last-failed.*` | The last response that failed it |

Comparing the last good and last failed responses usually shows what the
website changed. Each source is read by one file of its own, and saved
responses under `src/fetch/fixtures/` let a fix be tested without calling the
site.

## Running it

Requires [Node](https://nodejs.org) and [Rust](https://rustup.rs).

```
npm install
npm run tauri dev
```

Tests:

```
npm test                      # TypeScript
cd src-tauri && cargo test    # Rust
```

## Your data

The database lives in the operating system's application-support directory,
**outside this repository** — personal data and version control are separated by
architecture rather than by remembering to ignore a file. That boundary is
covered by its own regression tests.

There are no automatic backups. Notes and decisions can be exported to plain
files and kept wherever you choose.

## Status

Foundation complete. Portfolio and research features in progress.

## Licence

None. All rights reserved — this is published to be read, not reused.
