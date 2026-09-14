pub struct String {
}

impl String {
    pub fn new() -> Self {}

    pub fn push_str(&mut self, elem: String) {}
}

fn change(some_string: &String) {
	some_string.push_str(??)
}

fn main() {
    let s = String::new();

    change(&s);
}
