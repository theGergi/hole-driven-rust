// The hole should see variables from the outer scope but not from a finished inner block.

fn main() {
	{
		let x = "3";
	}
	let y = "4";
	let z: &str = ??;
}
