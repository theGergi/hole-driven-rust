// A string slice's `.chars()` also yields `Chars` (Item = char), so the loop variable `c` is
// `char` here too. This covers the `&str` receiver form (a string literal) rather than `String`.

fn main() {
    let target: char = 'x';
    let count: i32 = 0;

    for c in "hello".chars() {
        if c == ?? {
            count;
        }
    }
}
