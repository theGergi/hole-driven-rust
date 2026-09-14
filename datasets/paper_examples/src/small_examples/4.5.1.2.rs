fn func(a: &mut String) {
    a.push_str("Hello");
}

fn main() {
    let s1 = String::new();
    let mut s2 = String::new();

    let y = &s1;      // Type: &String
    let z = &mut s2;  // Type: &mut String

    let x = ??;

    func(x);

    func(??);
}