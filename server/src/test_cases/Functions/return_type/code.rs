// A `return ??` hole must resolve to the function's declared return type (i32),
// offering the in-scope i32 variables and the function itself.

fn pick() -> i32 {
    let a: i32 = 1;
    let b: i32 = 2;
    return ??;
}
