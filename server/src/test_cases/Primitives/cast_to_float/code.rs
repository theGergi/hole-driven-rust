// `?? as f64`: the hole may be filled by anything `as`-castable to f64, i.e. any
// integer or float value. `n` (i32) and `f` (f64) both qualify; the bool `b` does not,
// since `bool as f64` is not a valid cast.

fn main() {
    let n: i32 = 3;
    let f: f64 = 2.5;
    let b: bool = true;
    let x: f64 = ?? as f64;
}
