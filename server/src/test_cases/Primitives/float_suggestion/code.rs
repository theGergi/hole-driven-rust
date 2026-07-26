// An f64 hole should offer only float-typed values (`a`, `b`),
// and never the i32 `n`.

fn main() {
    let a: f64 = 1.5;
    let b: f64 = 2.5;
    let n: i32 = 3;
    let c: f64 = ??;
}
