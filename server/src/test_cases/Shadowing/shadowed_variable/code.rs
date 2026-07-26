// `x` is shadowed: the first binding is an i32, the second is a &str.
// A &str hole must resolve to the latest (shadowing) binding of `x`.
// If shadowing were ignored and the i32 binding won, `x` would not match
// the &str hole and would not be suggested at all.

fn main() {
    let x = 5;
    let x = "hello";
    let y: &str = ??;
}
