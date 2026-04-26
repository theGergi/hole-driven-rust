pub struct VecCustom<T> {
    ptr: *mut T,
    cap: integer,
    len_func: integer,
}

impl<T> VecCustom<T> {
    pub fn new() -> Self {}

    pub fn push(&mut self, elem: T) {}

	pub fn len(&mut self, a: integer) -> integer {}
}

pub fn rabin_karp(text: &string, pattern: &string) -> VecCustom<integer> {
    let z = VecCustom::new();
    let y: integer = z.??;
}