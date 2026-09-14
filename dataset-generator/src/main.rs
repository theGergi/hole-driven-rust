use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use proc_macro2::LineColumn;
use serde::Serialize;
use syn::visit::Visit;
use syn::File;
use walkdir::WalkDir;

mod collector;
mod shape;
mod util;

use collector::CandidateCollector;
use shape::Shape;

// ── Forms ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum Form {
    MethodCall,         // entire method call: foo.bar(args)
    FunctionCall,       // entire free-function call: foo(args)
    StructFieldAccess,  // entire field access: foo.bar
    ImmutableReference, // entire borrow expression: &foo
    MutableReference,   // entire mutable borrow: &mut foo
    VariableUse,        // any bare variable reference: foo
    Index,              // v[i]
    Range,              // 0..n, 1..=m
}

const ALL_FORMS: [Form; 8] = [
    Form::MethodCall,
    Form::FunctionCall,
    Form::StructFieldAccess,
    Form::ImmutableReference,
    Form::MutableReference,
    Form::VariableUse,
    Form::Index,
    Form::Range,
];

// ── Type classification ───────────────────────────────────────────────────────

fn strip_ref_prefix(mut ty: &str) -> &str {
    ty = ty.trim();
    while let Some(rest) = ty.strip_prefix('&') {
        let mut rest = rest.trim_start();
        if rest.starts_with('\'') {
            rest = rest.split_once(' ').map_or("", |(_, r)| r);
        }
        ty = rest.trim_start().strip_prefix("mut ").unwrap_or(rest).trim_start();
    }
    ty
}

// Last path segment of the type's head: `std::vec::Vec<i32>` → `Vec`.
fn type_base(ty: &str) -> &str {
    let base = ty.split('<').next().unwrap_or(ty).trim();
    base.rsplit("::").next().unwrap_or(base)
}

fn type_is_excluded(ty: &str) -> bool {
    let ty = strip_ref_prefix(ty);
    if ty.starts_with('(') && ty != "()" {
        return true;
    }
    matches!(type_base(ty), "Option" | "Result")
}

// ── Enum-choice detection ──────────────────────────────────────────────────────

const BARE_ENUM_VARIANTS: &[&str] = &["Some", "None", "Ok", "Err"];

fn path_is_enum_variant(path: &syn::Path) -> bool {
    let Some(last) = path.segments.last() else { return false };
    let name = last.ident.to_string();
    if !name.chars().next().map_or(false, |c| c.is_uppercase()) {
        return false;
    }
    path.segments.len() > 1 || BARE_ENUM_VARIANTS.contains(&name.as_str())
}

// ── Stage 1: Candidates ───────────────────────────────────────────────────────

struct Candidate {
    start:          LineColumn,
    end:            LineColumn,
    original:       String,
    form:           Form,
    ty:             Option<String>, // rustc-resolved type, attached after collection
    in_closure:     bool,
    in_tuple:       bool,
    in_enum_args:   bool,
    in_assign_lhs:  bool,
    is_enum_choice: bool,
    shape:          Shape,
}

// ── Source helpers ────────────────────────────────────────────────────────────

fn build_line_offsets(source: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    for (i, c) in source.char_indices() {
        if c == '\n' {
            offsets.push(i + 1);
        }
    }
    offsets
}

fn line_col_to_byte(source: &str, offsets: &[usize], line: usize, col: usize) -> usize {
    let base = offsets[line - 1];
    source[base..]
        .char_indices()
        .nth(col)
        .map_or(source.len(), |(i, _)| base + i)
}

// ── Stage 2: filter ────────────────────────────────────────────────────────────

fn filter_candidates(candidates: Vec<Candidate>) -> Vec<Candidate> {
    candidates
        .into_iter()
        .filter(|c| {
            !c.in_closure
                && !c.is_enum_choice
                && !c.in_tuple
                && !c.in_enum_args
                && !c.in_assign_lhs
                && !c.shape.has_tuple
                && !c.shape.has_enum
                && !c.shape.has_closure
                && c.shape.max_method_chain <= 1
                && !c.ty.as_deref().is_some_and(type_is_excluded)
        })
        .collect()
}

// ── Stats ─────────────────────────────────────────────────────────────────────

// Per-form candidate counts at each pipeline stage.
#[derive(Default)]
struct Stats {
    total:    HashMap<Form, usize>,
    filtered: HashMap<Form, usize>,
    holes:    HashMap<Form, usize>,
}

fn accumulate<'a>(counts: &mut HashMap<Form, usize>, cands: impl Iterator<Item = &'a Candidate>) {
    for c in cands {
        *counts.entry(c.form).or_insert(0) += 1;
    }
}

// ── File processor ────────────────────────────────────────────────────────────

struct ProcessSummary {
    total_candidates:    usize,
    filtered_candidates: usize,
    holes:               usize,
}

// Resolved types for one file's expression spans, keyed by
// (line_start, column_start, line_end, column_end).
type FileTypeIndex = HashMap<(usize, usize, usize, usize), String>;

fn process_file(
    input_path: &Path,
    output_dir: &Path,
    repo_root:  &Path,
    stats:      &mut Stats,
    type_index: Option<&FileTypeIndex>,
) -> Option<ProcessSummary> {
    let content = fs::read_to_string(input_path).ok()?;
    let ast: File = syn::parse_str(&content).ok()?;

    // Stage 1 — collect every candidate, unfiltered.
    let line_offsets = build_line_offsets(&content);
    let mut cand_col = CandidateCollector::new(&content, &line_offsets);
    cand_col.visit_file(&ast);
    let mut candidates = cand_col.into_candidates();

    // Attach rustc-resolved types where known.
    if let Some(idx) = type_index {
        for c in &mut candidates {
            if let Some(ty) = idx.get(&(c.start.line, c.start.column, c.end.line, c.end.column)) {
                c.ty = Some(ty.clone());
            }
        }
    }

    let rel_path  = input_path.strip_prefix(repo_root).ok()?.to_path_buf();
    let stem      = input_path.file_stem()?.to_string_lossy().into_owned();
    let file_name = input_path.file_name()?;

    let total_candidates = candidates.len();
    accumulate(&mut stats.total, candidates.iter());
    if util::write_raw_candidates(&candidates, &rel_path, output_dir).is_none() {
        eprintln!("{}: failed to write raw candidates", input_path.display());
    }

    // Stage 2 — filter
    let filtered = filter_candidates(candidates);
    let filtered_candidates = filtered.len();
    accumulate(&mut stats.filtered, filtered.iter());

    // Stage 3 — punch a hole for every filtered candidate.
    let type_checked = type_index.is_some();
    let written = util::write_hole_outputs(
        &output_dir.join("holes"), &rel_path, &stem, file_name,
        &content, &line_offsets, &filtered, type_checked,
    );
    let holes = written.len();
    accumulate(&mut stats.holes, written.into_iter());

    Some(ProcessSummary { total_candidates, filtered_candidates, holes })
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        util::print_usage(&args[0]);
        std::process::exit(1);
    }

    let repo_root  = PathBuf::from(&args[1]);
    let output_dir = PathBuf::from(&args[2]);

    util::prepare_output_dir(&output_dir);
    let tmp_dir = output_dir.join(".type-context-tmp");
    fs::create_dir_all(&tmp_dir).expect("failed to create temp dir");

    let mut files = 0usize;
    let mut total_total    = 0usize;
    let mut filtered_total = 0usize;
    let mut holes_total    = 0usize;
    let mut stats = Stats::default();

    let mut by_package: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    let mut no_package: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(&repo_root)
        .into_iter()
        .filter_entry(|e| !e.path().join(project_scraper::OUTPUT_MARKER).is_file())
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "rs"))
    {
        let path = entry.path().to_path_buf();
        match project_scraper::find_owning_manifest(&path) {
            Some(manifest) => by_package.entry(manifest.parent().unwrap().to_path_buf()).or_default().push(path),
            None => no_package.push(path),
        }
    }
    if !no_package.is_empty() {
        eprintln!(
            "WARN: {} file(s) have no owning Cargo.toml above them; holes will be generated without type info",
            no_package.len(),
        );
    }

    // Build type recorder binary
    let type_recorder_bin = if by_package.is_empty() {
        None
    } else {
        Some(project_scraper::sibling_binary("type-recorder"))
    };

    // Prep the process closure
    let mut process = |path: &Path, type_index: Option<&FileTypeIndex>| {
        let summary = process_file(path, &output_dir, &repo_root, &mut stats, type_index);
        util::print_file_summary(path, summary.as_ref());
        if let Some(s) = summary {
            files += 1;
            total_total    += s.total_candidates;
            filtered_total += s.filtered_candidates;
            holes_total    += s.holes;
        }
    };

    // Extract type map for every package and process the files with type map
    for (package_root, paths) in &by_package {
        let type_map = extract_type_context(package_root, &tmp_dir, type_recorder_bin.as_deref().unwrap());
        for path in paths {
            let key = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
            let index: Option<FileTypeIndex> = type_map.get(&key).map(|spans| {
                spans.iter()
                    .map(|s| ((s.line, s.column_start, s.line_end, s.column_end), s.r#type.clone()))
                    .collect()
            });
            process(path, index.as_ref());
        }
    }

    // No packae - no type map
    for path in &no_package {
        process(path, None);
    }

    let _ = fs::remove_dir_all(&tmp_dir);

    util::write_report(&output_dir, &stats, files, total_total, filtered_total, holes_total);
}

// Type-checks every file in the Cargo package via the type-recorder binary
// Runs as a separate process because the wrapper is pinned nightly toolchain.
fn extract_type_context(package_root: &Path, tmp_dir: &Path, type_recorder_bin: &Path) -> project_scraper::PackageTypeMap {
    let manifest = package_root.join("Cargo.toml");
    let slug = package_root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let result_file = tmp_dir.join(format!("{slug}.types.json"));

    println!("\n== Extracting type context for {} ==", package_root.display());
    let status = std::process::Command::new(type_recorder_bin)
        .arg(&manifest)
        .arg(&result_file)
        .status();
    match status {
        Ok(s) if !s.success() => {
            eprintln!("WARN type-recorder exited with {s} for {}", package_root.display());
            return project_scraper::PackageTypeMap::new();
        }
        Err(e) => {
            eprintln!("WARN failed to run type-recorder for {}: {e}", package_root.display());
            return project_scraper::PackageTypeMap::new();
        }
        _ => {}
    }

    let type_map: project_scraper::PackageTypeMap = fs::read_to_string(&result_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    if type_map.is_empty() {
        eprintln!(
            "WARN no type context extracted for {} (cargo check may have failed or resolved no expressions); holes in this package will have no type field",
            package_root.display(),
        );
    } else {
        let spans: usize = type_map.values().map(|v| v.len()).sum();
        println!("Extracted types for {spans} expression(s) across {} file(s).", type_map.len());
    }

    type_map
}
