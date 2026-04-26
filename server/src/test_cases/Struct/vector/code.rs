pub struct VecCustom<T> {
    ptr: *mut T,
    cap: integer,
    len: integer,
}

impl<T> VecCustom<T> {
    pub fn new() -> Self {}

    pub fn push(&mut self, elem: T) {}

	pub fn len(&mut self) -> integer {}
}

pub fn rabin_karp(text: &string, pattern: &string) -> VecCustom<integer> {
    let x : VecCustom<integer> = VecCustom::new();
    // let y : VecCustom<integer> = ??;
    x.??()
}