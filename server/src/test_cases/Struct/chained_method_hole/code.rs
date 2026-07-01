pub struct Inner {
    value: i32,
}

impl Inner {
    pub fn get_value(&self) -> i32 {}
}

pub struct Outer {
    inner: Inner,
}

impl Outer {
    pub fn new() -> Self {}

    pub fn get_inner(&self) -> Inner {}
}

pub fn main() {
    let z = Outer::new();
    let y: i32 = ??;
}
