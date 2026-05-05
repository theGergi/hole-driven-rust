pub struct String {
}

impl String {
    pub fn new() -> Self {}

    pub fn from(s: string) -> Self {}

    pub fn push_str(&mut self, s: &String) {}
}

fn read_string(s: &String) { // Function requires a parameter of type '&String'
	println!("I'm reading: {}", s);
}

fn modify_and_read_string(s: &mut String) { // Function requires a parameter of type '&mut String'
	s.push_str("b");
    println!("I'm reading: {}", s);
}

fn main() {
    let mut s = String::from("a"); // Create variable of type 'String'

    read_string(??); // Suggests &s

    modify_and_read_string(??); // Suggests &mut s
}