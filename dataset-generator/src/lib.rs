use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const PACKAGE_ROOT_ENV: &str = "TYPE_RECORDER_PACKAGE_ROOT";
pub const RESULT_DIR_ENV: &str = "TYPE_RECORDER_RESULT_DIR";
pub const OUTPUT_MARKER: &str = ".project-scraper-output";

// The resolved type of one expression span, as recorded by the RUSTC_WRAPPER
#[derive(Debug, Serialize, Deserialize)]
pub struct SpanType {
    pub line: usize,
    pub column_start: usize,
    pub line_end: usize,
    pub column_end: usize,
    pub r#type: String,
}

pub type PackageTypeMap = BTreeMap<PathBuf, Vec<SpanType>>;

pub fn find_owning_manifest(file: &Path) -> Option<PathBuf> {
    let mut dir = file.parent()?;
    loop {
        let candidate = dir.join("Cargo.toml");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }
}

pub fn sibling_binary(name: &str) -> PathBuf {
    let mut path = std::env::current_exe().expect("failed to resolve own executable path");
    path.pop();

    let is_release = path.file_name().is_some_and(|d| d == "release");
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "--bin", name, "--manifest-path", manifest]);
    if is_release {
        cmd.arg("--release");
    }
    match cmd.status() {
        Ok(s) if !s.success() => eprintln!("WARN failed to build sibling binary {name} (exit {s})"),
        Err(e) => eprintln!("WARN failed to invoke `cargo build` for sibling binary {name}: {e}"),
        _ => {}
    }

    path.push(name);
    if !path.is_file() {
        eprintln!("error: sibling binary {} not found even after a build attempt", path.display());
        std::process::exit(1);
    }
    path
}
