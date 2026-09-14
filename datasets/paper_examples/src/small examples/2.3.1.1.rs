fn main() {
    // 's1' owns the String
    let s1 = String::from("Rust");

    // Ownership is MOVED to 's2'
    let s2 = s1;

    // println!("{}", s1);
    // ^ ERROR! s1 is no longer valid.

    println!("{}", s2); // This works fine.
}