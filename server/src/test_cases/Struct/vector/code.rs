pub struct VecCustom<T> {
    ptr: *mut T,
    cap: integer,
    len: integer,
}

impl<T> VecCustom<T> {
    pub fn new() -> Self {}

    pub fn push(&mut self, elem: T) {}

	pub fn len_func(&mut self, a: integer) -> integer {}
}

pub fn main(text: &str, pattern: &str) {
    let x : VecCustom<integer> = ??;
}