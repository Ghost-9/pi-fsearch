//! Environment-driven configuration, shared by the daemon, the CLI and the
//! MCP server.
//!
//! Every knob has a `ULTRASEARCH_*` name. The historical `FSEARCH_*` names
//! are still read as fallbacks so an existing setup keeps its behaviour; the
//! new name wins when both are set.
//!
//! The point of the scan-root and index-dir knobs is testability: a test can
//! run a real daemon over a fixture tree, on its own socket, without touching
//! the live index or walking `/`. See `engine/BUILD.md`.

use std::path::PathBuf;

/// The first non-empty of two environment variables (primary, then legacy).
fn var(primary: &str, legacy: &str) -> Option<String> {
    std::env::var(primary)
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var(legacy).ok().filter(|v| !v.is_empty()))
}

/// The home directory paths are compared against (content scope, `~`
/// expansion, the default index location).
///
/// Resolved through `canonicalize` when it exists: the index holds real
/// paths (`/tmp` is `/private/tmp` on macOS, and a symlinked home would
/// otherwise match nothing).
pub fn home() -> String {
    let raw = var("ULTRASEARCH_HOME", "FSEARCH_HOME")
        .or_else(|| std::env::var("HOME").ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/".into());
    canonical(&raw)
}

/// A path as the index holds it: absolute and symlink-free, when it exists.
fn canonical(p: &str) -> String {
    std::fs::canonicalize(p).map_or_else(|_| p.to_string(), |c| c.to_string_lossy().into_owned())
}

/// Where the index lives: `index.bin`, `content/`, `fsearch.sock`.
pub fn data_dir() -> PathBuf {
    match var("ULTRASEARCH_DIR", "FSEARCH_DIR") {
        Some(d) => PathBuf::from(d),
        None => crate::engine::default_dir(&home()),
    }
}

/// The directory the first full crawl lists, `/` unless overridden. A test
/// points this at a fixture tree so a daemon start is milliseconds and
/// deterministic instead of a whole-disk crawl.
///
/// Canonicalized for the same reason as `home`: the crawl opens the root
/// with `O_NOFOLLOW_ANY`, which refuses a path with any symlink in it.
pub fn scan_root() -> Vec<u8> {
    match var("ULTRASEARCH_SCAN_ROOT", "FSEARCH_SCAN_ROOT") {
        Some(p) => {
            let p = canonical(p.trim_end_matches('/'));
            let p = p.trim_end_matches('/');
            if p.is_empty() { b"/".to_vec() } else { p.as_bytes().to_vec() }
        }
        None => b"/".to_vec(),
    }
}

/// Force the consent-gated folder skip list even with Full Disk Access.
pub fn restrict() -> bool {
    var("ULTRASEARCH_RESTRICT", "FSEARCH_RESTRICT").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `var` prefers the new name and ignores empty values, whichever name
    /// is used: the daemon must not start with `HOME=""`.
    #[test]
    fn env_precedence_and_empty() {
        // SAFETY: single-threaded test, and the names are test-specific.
        unsafe {
            std::env::set_var("ULTRASEARCH_TEST_A", "new");
            std::env::set_var("FSEARCH_TEST_A", "old");
            assert_eq!(var("ULTRASEARCH_TEST_A", "FSEARCH_TEST_A").as_deref(), Some("new"));
            std::env::set_var("ULTRASEARCH_TEST_A", "");
            assert_eq!(var("ULTRASEARCH_TEST_A", "FSEARCH_TEST_A").as_deref(), Some("old"));
            std::env::remove_var("FSEARCH_TEST_A");
            assert_eq!(var("ULTRASEARCH_TEST_A", "FSEARCH_TEST_A"), None);
        }
    }

    /// A trailing slash on the scan root would make the crawl skip the
    /// folder itself (an empty name component); the legacy name is read only
    /// when the new one is empty.
    #[test]
    fn scan_root_trims_trailing_slash() {
        // SAFETY: see above.
        unsafe {
            std::env::remove_var("FSEARCH_SCAN_ROOT");
            std::env::set_var("ULTRASEARCH_SCAN_ROOT", "/nonexistent-fixture/");
            assert_eq!(scan_root(), b"/nonexistent-fixture");
            std::env::set_var("ULTRASEARCH_SCAN_ROOT", "");
            std::env::set_var("FSEARCH_SCAN_ROOT", "/nonexistent-legacy/");
            assert_eq!(scan_root(), b"/nonexistent-legacy");
        }
    }

    /// A path with a symlink in it is resolved: the crawl opens the root with
    /// `O_NOFOLLOW_ANY`, which refuses `/tmp/...` (a link to `/private/tmp`).
    #[test]
    fn scan_root_resolves_symlinks() {
        // SAFETY: see above.
        #[cfg(target_os = "macos")]
        unsafe {
            std::env::remove_var("FSEARCH_SCAN_ROOT");
            std::env::set_var("ULTRASEARCH_SCAN_ROOT", "/tmp");
            assert_eq!(scan_root(), b"/private/tmp");
        }
    }
}
