fn main() {
    let mut r: &integer;                // 1. Declare a variable to hold a reference

    {                     // 2. Start a new inner scope
        let x = 5;        // 3. 'x' is created here
        r = &x;           // 4. 'r' takes a reference to 'x'
    }                     // 5. 'x' goes out of scope and is dropped!

    println!("{}", r);    // 6. ERROR! 'r' is pointing to nothing (a "dangling" reference)
    let x: &integer = ??;
}