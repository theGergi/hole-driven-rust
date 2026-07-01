// The hole should suggest only variables that have not been moved

fn main(a: &str) -> &str {
	let z: &str = "3";
	let y = "4";
	let r = y;
	let m: &str = ??;
}
