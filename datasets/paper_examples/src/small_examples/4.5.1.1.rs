fn f(a: i32) {}

fn main() {
    let x = ??;  // Type: i32, resolved from the call below
    f(x);
}