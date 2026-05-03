// The hole should suggest only variables that have not been moved

fn main() {
	{
		let z = vec!["a", "b", "c"];
		let r: Vec<string> = ??;
	}

	{
		let z = vec!["a"; 3];
		let r: Vec<string> = ??;
	}
}
