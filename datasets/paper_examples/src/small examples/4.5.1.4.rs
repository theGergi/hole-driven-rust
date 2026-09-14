fn func(a: &mut String) {
    a.push_str("Hello");
}

fn main() {
    let mut s = String::new();

    let x: &mut String = ??;

    let z = &mut s;  // Type: &mut String

    func(x); // x is still alive
}