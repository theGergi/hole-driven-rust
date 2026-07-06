pub struct Vec {
}

impl Vec {
    pub fn new() -> Self {}

    pub fn push(&mut self, elem: i32) {}
}

fn add_if_positive(a: &Vec, b: i32) {
    if b > 0 {
        ??
    }
}

fn main() {
    let a = Vec::new();

    add_if_positive(&a, 5);
}
