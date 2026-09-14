use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use project_scraper::{sibling_binary, PackageTypeMap, PACKAGE_ROOT_ENV, RESULT_DIR_ENV};

const WRAPPER_BIN_NAME: &str = "type-recorder-rustc-wrapper";

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: {} <manifest-path> <result-file>", args[0]);
        eprintln!();
        eprintln!("Type-checks every file in the Cargo package rooted at <manifest-path>'s");
        eprintln!("directory using rustc's own type checker, and writes the resolved type of");
        eprintln!("every expression in the package to <result-file> as a PackageTypeMap.");
        std::process::exit(1);
    }
    let manifest = fs::canonicalize(&args[1]).unwrap_or_else(|e| {
        eprintln!("{}: {e}", args[1]);
        std::process::exit(1);
    });

    let result_file = env::current_dir()
        .expect("failed to resolve current dir")
        .join(&args[2]);

    let package_root = manifest.parent().unwrap_or_else(|| {
        eprintln!("{}: manifest has no parent directory", manifest.display());
        std::process::exit(1);
    });

    let _ = fs::remove_file(&result_file);

    let result_dir = PathBuf::from(format!("{}.fragments", result_file.display()));
    let _ = fs::remove_dir_all(&result_dir);
    fs::create_dir_all(&result_dir).expect("failed to create result fragments dir");

    let target_dir = PathBuf::from(format!("{}.target", result_file.display()));
    let _ = fs::remove_dir_all(&target_dir);

    let wrapper_exe = sibling_binary(WRAPPER_BIN_NAME);
    let ld_library_path = nightly_sysroot_lib_dir();

    println!("Type-checking package {}...", manifest.display());

    let status = Command::new("cargo")
        .arg("check")
        .arg("--all-targets") // also type-checks #[cfg(test)] modules, where many holes live
        .arg("--manifest-path")
        .arg(&manifest)
        .arg("--target-dir")
        .arg(&target_dir)
        .env(PACKAGE_ROOT_ENV, package_root)
        .env(RESULT_DIR_ENV, &result_dir)
        .env("RUSTC_WRAPPER", &wrapper_exe)
        .env("LD_LIBRARY_PATH", &ld_library_path)
        .status();

    match status {
        Ok(s) if !s.success() => {
            eprintln!(
                "WARN cargo check failed for {} (exit {s}); type context may be incomplete",
                package_root.display(),
            );
        }
        Err(e) => {
            eprintln!("WARN failed to run cargo check for {}: {e}", package_root.display());
            std::process::exit(1);
        }
        _ => {}
    }

    let mut merged = PackageTypeMap::new();
    let mut fragments = 0usize;
    if let Ok(entries) = fs::read_dir(&result_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let Ok(content) = fs::read_to_string(entry.path()) else { continue };
            let Ok(fragment) = serde_json::from_str::<PackageTypeMap>(&content) else { continue };
            fragments += 1;
            for (file, spans) in fragment {
                merged.entry(file).or_default().extend(spans);
            }
        }
    }
    fs::write(&result_file, serde_json::to_string(&merged).unwrap()).expect("failed to write result file");
    let _ = fs::remove_dir_all(&result_dir);
    let _ = fs::remove_dir_all(&target_dir);

    println!(
        "Type context written to {} ({fragments} rustc invocation(s) merged)",
        result_file.display(),
    );
}

fn nightly_sysroot_lib_dir() -> PathBuf {
    let output = Command::new("rustc")
        .args(["+nightly", "--print", "sysroot"])
        .output()
        .expect("failed to run `rustc +nightly --print sysroot`");
    let sysroot = String::from_utf8(output.stdout)
        .expect("non-utf8 sysroot path")
        .trim()
        .to_string();
    PathBuf::from(sysroot).join("lib")
}
