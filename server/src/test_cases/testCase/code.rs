// This test case tests type inference for vectors.
// The hole ?? expects 'a' (a Vec<integer>)
// Explanation: 'a' is the only variable in scope with type Vec<integer>, inferred from vec![1,2,3].

fn main(a: string) -> integer {
	let a = vec![1, 2, 3];
	let c: Vec<integer> = ??;
}