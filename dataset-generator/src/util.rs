// Output: hole and raw-candidate files, the stats table, and console reporting.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use serde::Serialize;

use crate::shape::Shape;
use crate::{line_col_to_byte, Candidate, Form, ProcessSummary, Stats, ALL_FORMS};

// The one source of truth for a Form's external name is its serde rename.
fn serde_name(form: &Form) -> String {
    match serde_json::to_value(form) {
        Ok(serde_json::Value::String(s)) => s,
        _ => unreachable!("Form serializes to a plain string"),
    }
}

// ── Output types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct Replacement {
    line:         usize, // start line (kept as `line` for downstream compatibility)
    column_start: usize,
    line_end:     usize,
    column_end:   usize,
    original:     String,
    form:         Form,
    type_checked: bool,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    ty:           Option<String>,
}

#[derive(Debug, Serialize)]
struct RawCandidateEntry {
    index:          usize,
    line:           usize,
    column_start:   usize,
    line_end:       usize,
    column_end:     usize,
    original:       String,
    form:           Form,
    in_closure:     bool,
    in_tuple:       bool,
    in_enum_args:   bool,
    in_assign_lhs:  bool,
    is_enum_choice: bool,
    #[serde(flatten)]
    shape:          Shape,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    ty:             Option<String>,
}

#[derive(Debug, Serialize)]
struct RawCandidatesFile {
    file:             String,
    total_candidates: usize,
    form_counts:      BTreeMap<String, usize>,
    candidates:       Vec<RawCandidateEntry>,
}

// ── Stage 1 output: raw candidate record ──────────────────────────────────────

pub fn write_raw_candidates(candidates: &[Candidate], rel_path: &Path, output_dir: &Path) -> Option<()> {
    let mut form_counts: BTreeMap<String, usize> =
        ALL_FORMS.iter().map(|f| (serde_name(f), 0usize)).collect();

    let entries: Vec<RawCandidateEntry> = candidates.iter().enumerate().map(|(i, c)| {
        *form_counts.get_mut(&serde_name(&c.form)).unwrap() += 1;
        RawCandidateEntry {
            index:          i,
            line:           c.start.line,
            column_start:   c.start.column,
            line_end:       c.end.line,
            column_end:     c.end.column,
            original:       c.original.clone(),
            form:           c.form,
            in_closure:     c.in_closure,
            in_tuple:       c.in_tuple,
            in_enum_args:   c.in_enum_args,
            in_assign_lhs:  c.in_assign_lhs,
            is_enum_choice: c.is_enum_choice,
            shape:          c.shape,
            ty:             c.ty.clone(),
        }
    }).collect();

    let raw = RawCandidatesFile {
        file:             rel_path.to_string_lossy().replace('\\', "/"),
        total_candidates: candidates.len(),
        form_counts,
        candidates:       entries,
    };

    let dir = output_dir.join("candidates").join(rel_path.parent().unwrap_or(Path::new("")));
    fs::create_dir_all(&dir).ok()?;
    let stem = rel_path.file_stem()?.to_string_lossy().into_owned();
    let json = serde_json::to_string_pretty(&raw).ok()?;
    fs::write(dir.join(format!("{stem}.json")), json).ok()
}

// ── Stage 3: hole writing ─────────────────────────────────────────────────────

pub fn write_hole_outputs<'c>(
    holes_dir:    &Path,
    rel_path:     &Path,
    stem:         &str,
    file_name:    &std::ffi::OsStr,
    content:      &str,
    line_offsets: &[usize],
    candidates:   &'c [Candidate],
    type_checked: bool,
) -> Vec<&'c Candidate> {
    let file_dir = holes_dir
        .join(rel_path.parent().unwrap_or(Path::new("")))
        .join(stem);
    let mut written = Vec::new();

    for cand in candidates {
        let start = line_col_to_byte(content, line_offsets, cand.start.line, cand.start.column);
        let end   = line_col_to_byte(content, line_offsets, cand.end.line,   cand.end.column);
        let mut modified = content.to_string();
        modified.replace_range(start..end, "??");

        // Numbered by holes actually written, so directories have no gaps.
        let hole_dir = file_dir.join(format!("hole{}", written.len() + 1));
        if fs::create_dir_all(&hole_dir).is_err() {
            eprintln!("WARN failed to create {}", hole_dir.display());
            continue;
        }
        if fs::write(hole_dir.join(file_name), &modified).is_err() {
            eprintln!("WARN failed to write holed source in {}", hole_dir.display());
            continue;
        }

        let replacement = Replacement {
            line:         cand.start.line,
            column_start: cand.start.column,
            line_end:     cand.end.line,
            column_end:   cand.end.column,
            original:     cand.original.clone(),
            form:         cand.form,
            type_checked,
            ty:           cand.ty.clone(),
        };
        let json = match serde_json::to_string_pretty(&replacement) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("WARN failed to serialize hole metadata: {e}");
                continue;
            }
        };
        if fs::write(hole_dir.join(format!("{stem}.json")), json).is_err() {
            eprintln!("WARN failed to write hole metadata in {}", hole_dir.display());
            continue;
        }

        written.push(cand);
    }

    written
}

// ── Stats table and console ─────────────────────────────────────────────────────

fn format_stats_tables(
    stats: &Stats,
    total_candidates:    usize,
    filtered_candidates: usize,
    holes:               usize,
) -> String {
    let mut out = String::new();
    let row = |out: &mut String, name: &str, t: usize, f: usize, h: usize| {
        out.push_str(&format!("{name:<24} {t:>10} {f:>10} {h:>10}\n"));
    };

    out.push_str(&format!("{:<24} {:>10} {:>10} {:>10}\n", "Form", "Total", "Filtered", "Holes"));
    out.push_str(&format!("{}\n", "-".repeat(57)));
    for form in ALL_FORMS {
        let name = serde_name(&form);
        row(&mut out,
            &name,
            *stats.total.get(&form).unwrap_or(&0),
            *stats.filtered.get(&form).unwrap_or(&0),
            *stats.holes.get(&form).unwrap_or(&0));
    }
    out.push_str(&format!("{}\n", "-".repeat(57)));
    // Every candidate has exactly one form, so the form rows sum to these totals.
    row(&mut out, "Total", total_candidates, filtered_candidates, holes);
    out
}

// Prints the run summary and stats table, and saves the table to results.txt.
pub fn write_report(
    output_dir:     &Path,
    stats:          &Stats,
    files:          usize,
    total_total:    usize,
    filtered_total: usize,
    holes_total:    usize,
) {
    println!(
        "\nDone. {files} file(s) processed, {holes_total} hole(s) written.",
    );

    let tables = format_stats_tables(stats, total_total, filtered_total, holes_total);
    println!("\n{tables}");

    let table_path = output_dir.join("results.txt");
    if let Err(e) = fs::write(&table_path, &tables) {
        eprintln!("failed to write {}: {e}", table_path.display());
    }
}

pub fn print_file_summary(path: &Path, summary: Option<&ProcessSummary>) {
    match summary {
        Some(s) => println!(
            "{}: {} candidate(s), {} after filter -> {} hole(s)",
            path.display(), s.total_candidates, s.filtered_candidates, s.holes,
        ),
        None => println!("{}: skipped (parse failure)", path.display()),
    }
}

pub fn print_usage(program: &str) {
    eprintln!("Usage: {program} <repo-path> <output-dir>");
    eprintln!();
    eprintln!("Scans <repo-path> for *.rs files and records every candidate hole");
    eprintln!("location, filters out closure-body/-bearing, enum-choice, tuple-bearing,");
    eprintln!("tuple-element, assignment-target, multi-method-chain and excluded-type");
    eprintln!("expressions — plus the literal and binary_op forms wholesale");
    eprintln!("(recorded under candidates/ only) — then writes one hole per filtered");
    eprintln!("candidate under holes/.");
    eprintln!();
    eprintln!("Raw (pre-filter) candidate records are written under candidates/.");
}

// Wipes a previous run's outputs
pub fn prepare_output_dir(output_dir: &Path) {
    if output_dir.exists() {
        if output_dir.join(project_scraper::OUTPUT_MARKER).is_file() {
            for sub in ["candidates", "holes"] {
                let _ = fs::remove_dir_all(output_dir.join(sub));
            }
            let _ = fs::remove_file(output_dir.join("results.txt"));
        } else if fs::read_dir(&output_dir).map(|mut d| d.next().is_some()).unwrap_or(false) {
            eprintln!(
                "error: {} exists, is not empty, and has no {} marker; refusing to write into it",
                output_dir.display(), project_scraper::OUTPUT_MARKER,
            );
            std::process::exit(1);
        }
    }

    fs::create_dir_all(output_dir.join("candidates")).expect("failed to create output dir");
    fs::create_dir_all(output_dir.join("holes")).expect("failed to create output dir");
    fs::write(output_dir.join(project_scraper::OUTPUT_MARKER), "").expect("failed to write output marker");
}
