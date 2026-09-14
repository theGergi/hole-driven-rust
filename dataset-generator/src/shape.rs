use serde::Serialize;
use syn::Expr;

#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct Shape {
    pub has_tuple:        bool,
    pub has_enum:         bool,
    pub has_closure:      bool,
    pub max_method_chain: usize,
}

impl Shape {
    pub fn merge(&mut self, other: Shape) {
        self.has_tuple        |= other.has_tuple;
        self.has_enum         |= other.has_enum;
        self.has_closure      |= other.has_closure;
        self.max_method_chain  = self.max_method_chain.max(other.max_method_chain);
    }
}

// Length of the method chain ending at `node`: `a.m1()` → 1, `a.m1().m2()` → 2.
pub fn chain_len(expr: &Expr) -> usize {
    match expr {
        Expr::MethodCall(m) => 1 + chain_len(&m.receiver),
        Expr::Await(a)      => chain_len(&a.base),
        Expr::Try(t)        => chain_len(&t.expr),
        _ => 0,
    }
}
