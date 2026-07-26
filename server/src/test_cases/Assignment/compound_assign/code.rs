// A compound assignment `total += ??` should offer i32-typed values for the
// right-hand side (the operand added to `total`).

fn main() {
    let a: i32 = 5;
    let mut total: i32 = 0;
    total += ??;
}
