pub struct VecIterator<T> {}

impl<T> VecIterator<T> {
    pub fn enumerate(&self) -> Vec<(usize, &T)> {}
}


pub struct Vec<T> {}

impl<T> Vec<T> {
    pub fn new() -> Self {}

    pub fn push(&mut self, elem: T) {}

	pub fn len(&self) -> integer {}

    pub fn is_empty(&self) -> boolean {}

    pub fn iter(&self) -> VecIterator<T> {}

    pub fn get(&self, index: usize) -> &T {}
}

pub fn new() {

}

fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32> {
    let mut map = new();

    for &num in nums.iter().enumerate() {
        let complement : i32 = target - 2;

        if let prev_index: i32 = map.get(??) {
            return vec![prev_index as i32];
        }

        map.insert(num);
    }

    vec![]
}