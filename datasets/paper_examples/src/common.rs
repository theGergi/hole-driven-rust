fn common(l1: Vec<i32>, l2: Vec<i32>) -> Vec<i32> {
    let mut res: Vec<i32> = l1.into_iter()
        .filter(|n: &i32| l2.contains(n))
        .collect();
    res.sort();
    return ??; // answer: res
}