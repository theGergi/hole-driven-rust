pub struct VecIterator<T> {}

impl<T> VecIterator<T> {}

pub struct Vec<T> {}

impl<T> Vec<T> {
    pub fn iter(&self) -> VecIterator<T> {}
}

pub struct String {}

impl String {
    pub fn new() -> Self {}

    pub fn as_bytes(&self) -> Vec<integer> {}
}


fn iter_sum(iter: &VecIterator) {
    let mut sum = 0;
    for &byte in iter {
        sum = sum + byte;
    }
}

fn main() {
    let s = String::new();
    let s_bytes = s.as_bytes();
    let bytes_iter = s_bytes.iter();

    iter_sum(??);
}