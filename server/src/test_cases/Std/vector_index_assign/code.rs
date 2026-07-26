// Assigning to a vector element `v[0] = ??` should offer i32-typed values,
// including indexing back into the same vector `v[??]`.

fn main() {
    let val: i32 = 7;
    let mut v = vec![1, 2, 3];
    v[0] = ??;
}
