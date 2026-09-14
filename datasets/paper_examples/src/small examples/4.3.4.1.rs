fn main() {
    let a = String::from("3");  // Create 'String' value

    let b = a;                  // Move 'String' value from a to b
                                // since 'String' does not implement
                                // the 'Copy' trait

    let result: String = ??;    // Suggests only b
}