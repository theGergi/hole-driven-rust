// A `while ??` condition is a boolean context (like `if ??`), so the hole
// should offer the bool `done`, not the i32 `n`.

fn main() {
    let done: bool = false;
    let n: i32 = 3;
    while ?? {
        let x = 1;
    }
}
