// `?? as i32`: an integer cast target accepts every numeric value plus bool and char,
// so the i32 `n`, the f64 `f`, the bool `b` and the char `c` are all valid fillers.
// A `String` (`s`) is not `as`-castable to i32 and must not be offered.

fn main() {
    let n: i32 = 3;
    let f: f64 = 2.5;
    let b: bool = true;
    let c: char = 'a';
    let s: String = String::new();
    let x: i32 = ?? as i32;
}
