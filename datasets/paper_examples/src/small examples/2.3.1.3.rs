fn main() {
    let r;                // ---------+-- 'a (Lifetime of r)
    {                     //          |
        let x = 5;        // --+-- 'b | (Lifetime of x)
        r = &x;           //   |      |
    }                     // --+      | x is dropped here!
    println!("r: {}", r); //          | ERROR: r points to invalid memory!
}                         // ---------+