// An `if ??` condition is a boolean context, so the hole should offer
// bool-typed values (the `flag` variable), not the i32 `n`.

fn is_ready() -> bool {
    return true;
}

fn main() {
    let flag: bool = true;
    let n: i32 = 3;
    if ?? {
        let x = 1;
    }
}
