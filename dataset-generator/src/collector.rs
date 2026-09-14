// Stage 1: walks a file's AST and records every expression that could become a hole.

use std::collections::HashSet;
use proc_macro2::LineColumn;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{
    BinOp, Expr, ExprAssign, ExprBinary, ExprCall, ExprClosure, ExprField, ExprIndex,
    ExprMethodCall, ExprPath, ExprRange, ExprReference, ExprStruct, ExprTuple, Member, Pat,
    PatTuple, PatTupleStruct, PathArguments, TypeTuple,
};

use crate::shape::{chain_len, Shape};
use crate::{line_col_to_byte, path_is_enum_variant, Candidate, Form};

// `+=`, `-=`, … — the binary ops whose left operand is an assignment target.
fn is_assign_op(op: &BinOp) -> bool {
    matches!(op,
        BinOp::AddAssign(_) | BinOp::SubAssign(_) | BinOp::MulAssign(_)
        | BinOp::DivAssign(_) | BinOp::RemAssign(_) | BinOp::BitXorAssign(_)
        | BinOp::BitAndAssign(_) | BinOp::BitOrAssign(_)
        | BinOp::ShlAssign(_) | BinOp::ShrAssign(_))
}

fn is_literal_like(expr: &Expr) -> bool {
    match expr {
        Expr::Lit(_)        => true,
        Expr::Unary(u)      => is_literal_like(&u.expr),
        Expr::Reference(r)  => is_literal_like(&r.expr),
        Expr::Paren(p)      => is_literal_like(&p.expr),
        Expr::Group(g)      => is_literal_like(&g.expr),
        Expr::MethodCall(m) => is_literal_like(&m.receiver),
        Expr::Index(i)      => is_literal_like(&i.expr),
        Expr::Array(a)      => a.elems.iter().all(is_literal_like),
        _ => false,
    }
}

fn simple_path_ident_start(expr: &Expr) -> Option<(usize, usize)> {
    if let Expr::Path(path) = expr {
        if path.qself.is_none()
            && path.path.leading_colon.is_none()
            && path.path.segments.len() == 1
        {
            let seg = &path.path.segments[0];
            if matches!(seg.arguments, PathArguments::None) {
                let s = seg.ident.span().start();
                return Some((s.line, s.column));
            }
        }
    }
    None
}

pub struct CandidateCollector<'a> {
    source:       &'a str,
    line_offsets: &'a [usize],
    skip_spans:       HashSet<(usize, usize)>, // single-ident callees: not variable uses
    closure_depth:    usize, // >0 while visiting inside a lambda/closure body
    tuple_depth:      usize, // >0 while visiting inside a tuple literal
    enum_args_depth:  usize, // >0 while visiting the arguments of an enum variant call
    assign_lhs_depth: usize, // >0 while visiting the target side of an assignment
    pattern_depth:    usize, // >0 while visiting inside a pattern (match arms, …)
    shape:            Shape, // shape of everything visited so far in the innermost `scoped` subtree
    pub candidates: Vec<Candidate>,
}

impl<'a> CandidateCollector<'a> {
    pub fn new(source: &'a str, line_offsets: &'a [usize]) -> Self {
        Self {
            source,
            line_offsets,
            skip_spans:       HashSet::new(),
            closure_depth:    0,
            tuple_depth:      0,
            enum_args_depth:  0,
            assign_lhs_depth: 0,
            pattern_depth:    0,
            shape:            Shape::default(),
            candidates:       Vec::new(),
        }
    }

    fn span_text(&self, start: LineColumn, end: LineColumn) -> Option<String> {
        let s = line_col_to_byte(self.source, self.line_offsets, start.line, start.column);
        let e = line_col_to_byte(self.source, self.line_offsets, end.line,   end.column);
        self.source.get(s..e).map(|t| t.to_string())
    }

    fn push(&mut self, start: LineColumn, end: LineColumn, form: Form, is_enum_choice: bool, shape: Shape) {
        if start.line == 0 || self.pattern_depth > 0 {
            return;
        }
        let Some(original) = self.span_text(start, end) else { return };
        if original.is_empty() {
            return;
        }
        self.candidates.push(Candidate {
            start,
            end,
            original,
            form,
            ty:            None,
            in_closure:    self.closure_depth > 0,
            in_tuple:      self.tuple_depth > 0,
            in_enum_args:  self.enum_args_depth > 0,
            in_assign_lhs: self.assign_lhs_depth > 0,
            is_enum_choice,
            shape,
        });
    }

    fn push_whole(&mut self, span: proc_macro2::Span, form: Form, is_enum_choice: bool, shape: Shape) {
        self.push(span.start(), span.end(), form, is_enum_choice, shape);
    }

    fn scoped(&mut self, visit: impl FnOnce(&mut Self)) -> Shape {
        let outer = std::mem::take(&mut self.shape);
        visit(self);
        let inner = std::mem::replace(&mut self.shape, outer);
        self.shape.merge(inner);
        inner
    }

    pub fn into_candidates(mut self) -> Vec<Candidate> {
        self.candidates.sort_by_key(|c| (c.start.line, c.start.column, std::cmp::Reverse((c.end.line, c.end.column))));
        self.candidates
    }
}

impl<'ast, 'a> Visit<'ast> for CandidateCollector<'a> {
    // ── Patterns: no candidates inside ────────────────────────────────────────
    fn visit_pat(&mut self, node: &'ast Pat) {
        self.pattern_depth += 1;
        syn::visit::visit_pat(self, node);
        self.pattern_depth -= 1;
    }

    // ── Whole method call: foo.bar(args) ──────────────────────────────────────
    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        let shape = self.scoped(|s| {
            s.shape.max_method_chain = 1 + chain_len(&node.receiver);
            syn::visit::visit_expr_method_call(s, node);
        });
        if !is_literal_like(&node.receiver) {
            self.push_whole(node.span(), Form::MethodCall, false, shape);
        }
    }

    // ── Whole field access: foo.bar ───────────────────────────────────────────
    fn visit_expr_field(&mut self, node: &'ast ExprField) {
        let shape = self.scoped(|s| {
            // Tuple-index access: `pair.0`
            if matches!(node.member, Member::Unnamed(_)) {
                s.shape.has_tuple = true;
            }
            syn::visit::visit_expr_field(s, node);
        });
        self.push_whole(node.span(), Form::StructFieldAccess, false, shape);
    }

    // ── Free function call: foo(args) ─────────────────────────────────────────
    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        let is_enum_choice = matches!(
            node.func.as_ref(),
            Expr::Path(p) if p.qself.is_none() && path_is_enum_variant(&p.path)
        );

        // Mark the callee span so record_variable_use skips it as a variable.
        if let Some(key) = simple_path_ident_start(&node.func) {
            self.skip_spans.insert(key);
        }

        if is_enum_choice {
            self.enum_args_depth += 1;
        }
        let shape = self.scoped(|s| syn::visit::visit_expr_call(s, node));
        if is_enum_choice {
            self.enum_args_depth -= 1;
        }
        self.push_whole(node.span(), Form::FunctionCall, is_enum_choice, shape);
    }

    // ── Assignment: foo = bar ─────────────────────────────────────────────────
    fn visit_expr_assign(&mut self, node: &'ast ExprAssign) {
        for attr in &node.attrs {
            self.visit_attribute(attr);
        }
        self.assign_lhs_depth += 1;
        self.visit_expr(&node.left);
        self.assign_lhs_depth -= 1;
        self.visit_expr(&node.right);
    }

    // ── Binary ops ────────────────────────────────────────────────────────────
    fn visit_expr_binary(&mut self, node: &'ast ExprBinary) {
        if is_assign_op(&node.op) {
            for attr in &node.attrs {
                self.visit_attribute(attr);
            }
            self.assign_lhs_depth += 1;
            self.visit_expr(&node.left);
            self.assign_lhs_depth -= 1;
            self.visit_expr(&node.right);
            return;
        }
        syn::visit::visit_expr_binary(self, node);
    }

    // ── Whole index expression: v[i] ──────────────────────────────────────────
    fn visit_expr_index(&mut self, node: &'ast ExprIndex) {
        let shape = self.scoped(|s| syn::visit::visit_expr_index(s, node));
        if !is_literal_like(&node.expr) {
            self.push_whole(node.span(), Form::Index, false, shape);
        }
    }

    // ── Range: 0..n ───────────────────────────────────────────────────────────
    fn visit_expr_range(&mut self, node: &'ast ExprRange) {
        let shape = self.scoped(|s| syn::visit::visit_expr_range(s, node));
        self.push_whole(node.span(), Form::Range, false, shape);
    }

    // ── Tuple literal: (a, b)  ────────────────────────────────────────────────
    fn visit_expr_tuple(&mut self, node: &'ast ExprTuple) {
        self.shape.has_tuple = true;
        self.tuple_depth += 1;
        syn::visit::visit_expr_tuple(self, node);
        self.tuple_depth -= 1;
    }

    // ── Closures / lambdas ────────────────────────────────────────────────────
    fn visit_expr_closure(&mut self, node: &'ast ExprClosure) {
        self.shape.has_closure = true;
        self.closure_depth += 1;
        syn::visit::visit_expr_closure(self, node);
        self.closure_depth -= 1;
    }

    // ── Borrow expressions: &foo / &mut foo ───────────────────────────────────
    fn visit_expr_reference(&mut self, node: &'ast ExprReference) {
        let shape = self.scoped(|s| syn::visit::visit_expr_reference(s, node));
        if is_literal_like(&node.expr) {
            return;
        }
        let form = if node.mutability.is_some() {
            Form::MutableReference
        } else {
            Form::ImmutableReference
        };
        self.push_whole(node.span(), form, false, shape);
    }

    // ── Variable use / enum variant path: foo, Enum::Variant ─────────────────
    fn visit_expr_path(&mut self, node: &'ast ExprPath) {
        if node.qself.is_none() && path_is_enum_variant(&node.path) {
            self.shape.has_enum = true;
        }
        self.record_variable_use(node);
        syn::visit::visit_expr_path(self, node);
    }

    // Struct-form variant literal: `Enum::Variant { … }`
    fn visit_expr_struct(&mut self, node: &'ast ExprStruct) {
        if node.qself.is_none() && path_is_enum_variant(&node.path) {
            self.shape.has_enum = true;
        }
        syn::visit::visit_expr_struct(self, node);
    }

    fn visit_type_tuple(&mut self, node: &'ast TypeTuple) {
        if !node.elems.is_empty() {
            self.shape.has_tuple = true;
        }
        syn::visit::visit_type_tuple(self, node);
    }

    fn visit_pat_tuple(&mut self, node: &'ast PatTuple) {
        self.shape.has_tuple = true;
        syn::visit::visit_pat_tuple(self, node);
    }

    fn visit_pat_tuple_struct(&mut self, node: &'ast PatTupleStruct) {
        self.shape.has_tuple = true;
        syn::visit::visit_pat_tuple_struct(self, node);
    }
}

impl<'a> CandidateCollector<'a> {
    // Record a bare variable reference.
    fn record_variable_use(&mut self, node: &ExprPath) {
        if node.qself.is_some()
            || node.path.leading_colon.is_some()
            || node.path.segments.len() != 1
        {
            return;
        }
        let seg = &node.path.segments[0];
        if !matches!(seg.arguments, PathArguments::None) {
            return;
        }
        let name = seg.ident.to_string();
        if !name.chars().next().is_some_and(|c| c.is_lowercase()) || name == "self" {
            return;
        }
        let span  = seg.ident.span();
        let (start, end) = (span.start(), span.end());
        if self.skip_spans.contains(&(start.line, start.column)) {
            return;
        }
        self.push(start, end, Form::VariableUse, false, Shape::default());
    }
}
