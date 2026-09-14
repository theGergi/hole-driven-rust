#![feature(rustc_private)]

extern crate rustc_driver;
extern crate rustc_hir;
extern crate rustc_interface;
extern crate rustc_middle;
extern crate rustc_span;

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use rustc_hir::intravisit::Visitor;
use rustc_middle::ty::TyCtxt;
use project_scraper::{PackageTypeMap, SpanType, PACKAGE_ROOT_ENV, RESULT_DIR_ENV};

fn main() -> std::process::ExitCode {
    let args: Vec<String> = env::args().collect();
    let real_rustc = args.get(1).cloned().unwrap_or_else(|| "rustc".to_string());
    let rustc_args: Vec<String> = args.get(2..).map(|a| a.to_vec()).unwrap_or_default();

    let package_root = PathBuf::from(env::var(PACKAGE_ROOT_ENV).expect("missing package root env"));

    let primary_input = rustc_args
        .iter()
        .find(|a| !a.starts_with('-') && a.ends_with(".rs"))
        .map(PathBuf::from);

    let belongs_to_package = primary_input
        .as_ref()
        .and_then(|p| fs::canonicalize(p).ok())
        .map_or(false, |p| p.starts_with(&package_root));

    if !belongs_to_package {
        let status = Command::new(&real_rustc)
            .args(&rustc_args)
            .status()
            .unwrap_or_else(|e| panic!("failed to spawn real rustc ({real_rustc}): {e}"));
        return if status.success() {
            std::process::ExitCode::SUCCESS
        } else {
            std::process::ExitCode::from(status.code().unwrap_or(1) as u8)
        };
    }

    let result_dir = PathBuf::from(env::var(RESULT_DIR_ENV).expect("missing result dir env"));

    let results: Arc<Mutex<PackageTypeMap>> = Arc::new(Mutex::new(PackageTypeMap::new()));

    let mut full_args = vec![real_rustc];
    full_args.extend(rustc_args);

    let mut callbacks = TypeRecorderCallbacks {
        results: results.clone(),
    };

    let exit_code = rustc_driver::catch_with_exit_code(|| {
        rustc_driver::run_compiler(&full_args, &mut callbacks);
    });

    let fragment = result_dir.join(format!("{}.json", std::process::id()));
    if let Err(e) = fs::write(&fragment, serde_json::to_string(&*results.lock().unwrap()).unwrap()) {
        eprintln!("WARN failed to write type-context fragment {}: {e}", fragment.display());
    }

    exit_code
}

struct TypeRecorderCallbacks {
    results: Arc<Mutex<PackageTypeMap>>,
}

impl rustc_driver::Callbacks for TypeRecorderCallbacks {
    fn after_analysis<'tcx>(
        &mut self,
        _compiler: &rustc_interface::interface::Compiler,
        tcx: TyCtxt<'tcx>,
    ) -> rustc_driver::Compilation {
        let source_map = tcx.sess.source_map();
        let mut canon_cache = HashMap::new();
        for def_id in tcx.hir_body_owners() {
            let typeck_results = tcx.typeck(def_id);
            let body = tcx.hir_body_owned_by(def_id);
            let mut visitor = ExprFinder {
                source_map,
                typeck_results,
                results: &self.results,
                canon_cache: &mut canon_cache,
            };
            visitor.visit_body(body);
        }
        rustc_driver::Compilation::Continue
    }
}

struct ExprFinder<'a, 'tcx> {
    source_map: &'a rustc_span::source_map::SourceMap,
    typeck_results: &'tcx rustc_middle::ty::TypeckResults<'tcx>,
    results: &'a Arc<Mutex<PackageTypeMap>>,
    // `fs::canonicalize` is a syscall; a body can visit thousands of
    // expressions that all resolve to the same source file, so cache it
    // per raw path instead of re-resolving on every single expression.
    canon_cache: &'a mut HashMap<PathBuf, PathBuf>,
}

impl<'a, 'tcx> Visitor<'tcx> for ExprFinder<'a, 'tcx> {
    fn visit_expr(&mut self, ex: &'tcx rustc_hir::Expr<'tcx>) {
        let span = ex.span;
        let record_span = if !span.from_expansion() {
            Some(span)
        } else if span.desugaring_kind() == Some(rustc_span::DesugaringKind::RangeExpr)
            && matches!(ex.kind, rustc_hir::ExprKind::Struct(..) | rustc_hir::ExprKind::Call(..))
        {
            span.parent_callsite().filter(|cs| !cs.from_expansion())
        } else {
            None
        };
        if let Some(span) = record_span {
            let lo = source_map_pos(self.source_map, span.lo());
            let hi = source_map_pos(self.source_map, span.hi());
            if let (Some((file, line, col_start)), Some((_, line_end, col_end))) = (lo, hi) {
                let file = self.canon_cache
                    .entry(file.clone())
                    .or_insert_with(|| fs::canonicalize(&file).unwrap_or(file))
                    .clone();
                let ty = self.typeck_results.expr_ty(ex);
                self.results.lock().unwrap().entry(file).or_default().push(SpanType {
                    line,
                    column_start: col_start,
                    line_end,
                    column_end: col_end,
                    r#type: ty.to_string(),
                });
            }
        }
        rustc_hir::intravisit::walk_expr(self, ex);
    }
}

fn source_map_pos(
    source_map: &rustc_span::source_map::SourceMap,
    pos: rustc_span::BytePos,
) -> Option<(PathBuf, usize, usize)> {
    let loc = source_map.lookup_char_pos(pos);
    let path = match &loc.file.name {
        rustc_span::FileName::Real(real) => real.local_path()?.to_path_buf(),
        _ => return None,
    };
    Some((path, loc.line, loc.col.0))
}
