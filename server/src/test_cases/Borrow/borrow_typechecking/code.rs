fn main() {
    let mut s = String::from("a");

    let r1: &String     = &s;        // shared borrow
    let r2: &String     = &s;        // second shared borrow (allowed)
    let r_mut: &mut String     = &mut s;        // mutable borrow (fine because r1 and r2 go out of scope)
}