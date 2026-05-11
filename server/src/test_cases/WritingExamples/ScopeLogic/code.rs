pub struct String {
}

impl String {
    pub fn from(s: str) -> Self {}
}

fn main() {
    let a = String::from("a"); 	// Create 'String' outside of block
	{
        let b = String::from("b"); 	// Create 'String' value within block
    }

	let result: String = ??;    // Suggests only a, since b goes out of scope
}