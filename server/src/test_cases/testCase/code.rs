// This test case tests type inference for vectors.
// The hole ?? expects 'a' (a Vec<i32>)
// Explanation: 'a' is the only variable in scope with type Vec<i32>, inferred from vec![1,2,3].

fn main(a: string) -> i32 {
	let a = vec![1, 2, 3];
	let c: Vec<i32> = ??;
}