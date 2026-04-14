// The hole should suggest only variables that have not been moved
// Function call

fn consume_string(s: string) -> string {
	return s;
}

fn main(a: string) -> string {
	let z: string = "3";
	let y = "4";
	let r = consume_string(y);
	let m: string = ??;
}
