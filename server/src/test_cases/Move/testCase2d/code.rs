// The hole should suggest only variables that have not been moved
// Function call

fn consume_string(s: str) -> str {
	return s;
}

fn main(a: str) -> str {
	let z: str = "3";
	let y = "4";
	let r = consume_string(y);
	let m: str = ??;
}
