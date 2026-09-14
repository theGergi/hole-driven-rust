// Function requires a parameter of type '&String'
fn read_string(s: &String) {
    println!("I'm reading: {}", s);
}

// Function requires a parameter of type '&mut String'
fn modify_and_read_string(s: &mut String) {
    s.push_str("b");
    println!("I'm reading: {}", s);
}

fn main() {
    let mut s = String::from("a"); // Create variable of type 'String'

    read_string(??);               // Suggests &s

    modify_and_read_string(??);    // Suggests &mut s
}