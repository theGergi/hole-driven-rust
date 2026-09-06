// Introduction example: the hole is the return expression, so it must be a
// Vec<i32>. l1, l2 and res all have that type, but l1 was consumed by
// into_iter() on the first line and is no longer usable.

fn common(l1: Vec<i32>, l2: Vec<i32>) -> Vec<i32> {
    let mut res: Vec<i32> = l1.into_iter().filter(|n: &i32| l2.contains(n)).collect();
    res.sort();
    return ??; // Suggests res and l2, but not l1
}
