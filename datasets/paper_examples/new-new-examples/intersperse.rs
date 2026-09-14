fn intersperse(numbers: Vec<u32>, delimeter: u32) -> Vec<u32> {
    let mut res: Vec<u32> = vec![];
    numbers.iter().for_each(|item: &u32| {
        res.push(*item);
        res.push(delimeter);
    });
    ??.pop(); // answer: res
    return res;
}