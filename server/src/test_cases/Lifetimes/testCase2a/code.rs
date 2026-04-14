// The hole should see variables before and in the inner block plus function parameters.

fn main(a: string) -> string {
	let x = "x";
	{
		let y = "y";
		let z: string = ??;
	}
}
