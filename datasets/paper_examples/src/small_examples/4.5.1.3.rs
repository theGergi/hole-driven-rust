fn func(a: &mut String) {
    a.push_str("Hello");
}

fn main() {
    let mut s = String::new();

    let z = &mut s;  // Type: &mut String

    let x: &mut String = ??;

    func(z); // z is still alive
}