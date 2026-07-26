// Iterating a `String` via `.chars()` yields a `Chars` iterator whose Iterator::Item is `char`
// (String derefs to str, whose `chars` returns Chars). The loop variable `c` is therefore typed
// `char`, so in `c == ??` the hole takes type `char`: the `char` `target` fits, the `i32` `count`
// does not.

fn main() {
    let target: char = 'x';
    let count: i32 = 0;
    let s: String = String::from("hello");

    for c in s.chars() {
        if c == ?? {
            count;
        }
    }
}
