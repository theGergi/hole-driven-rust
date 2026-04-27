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

pub fn main(text: &string, pattern: &string) -> VecCustom<integer> {
    let z = VecCustom::new();
    let y: integer = ??;
}