// Introduction example: the hole is the receiver of pop(), so it must be a
// Vec<u32> that can be mutably borrowed. Only res qualifies: numbers has the
// right type but is not declared mut, and delimeter has the wrong type.

fn intersperse(numbers: Vec<u32>, delimeter: u32) -> Vec<u32> {
    let mut res: Vec<u32> = vec![];
    numbers.iter().for_each(|item: &u32| { res.push(*item); res.push(delimeter); });
    ??.pop(); // Suggests res
    return res;
}
