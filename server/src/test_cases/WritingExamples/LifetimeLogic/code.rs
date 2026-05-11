pub struct String {
}

impl String {
    pub fn new() -> Self {}

    pub fn from(s: str) -> Self {}

    pub fn push_str(&mut self, s: &String) {}
}

fn modify_and_read_string(s: &mut String) { // Function requires a parameter of type '&mut String'
	s.push_str("b");
    println!("I'm reading: {}", s);
}

fn main() {
    let mut x = String::from("");
    let y = &mut x;             // 'y lifetime starts

    modify_and_read_string(??); // Suggest only y
                                // x cannot be borrowed while y is live
                               
    modify_and_read_string(y);  // 'y lifetime ends here

    modify_and_read_string(??); // Suggest y and &mut x
                                // since y is no longer live
}