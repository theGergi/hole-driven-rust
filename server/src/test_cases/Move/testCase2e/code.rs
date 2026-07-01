// The hole should suggest only variables that have not been moved
// Assignement

fn main(a: &str) -> &str {
	let z: &str = "3";
	let mut r = "";
	let y = "4";
	r = y;
	let m: &str = ??;
}
