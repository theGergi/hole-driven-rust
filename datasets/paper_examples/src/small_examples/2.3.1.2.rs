fn main() {
    let s1 = String::from("Rust");

    // We pass a BORROW (&s1) instead of moving it
    let len = calculate_length(&s1);

    // s1 is still the owner and remains valid here!
    println!("The length of '{}' is {}.", s1, len);
}

fn calculate_length(s: &String) -> usize {
    s.len()
} // 's' (the borrow) goes out of scope here, but nothing happens to the data