pub struct VecCustom<T> {
    ptr: *mut T,
    cap: i32,
    len: i32,
}

impl<T> VecCustom<T> {
    pub fn new() -> Self {}

    pub fn push(&mut self, elem: T) {}

	pub fn len_func(&mut self, a: i32) -> i32 {}
}

pub fn main(text: &str, pattern: &str) -> VecCustom<i32> {
    let mut z = VecCustom::new();
    let y: i32 = z.??;
}