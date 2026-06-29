pub struct CustomStruct<T> {
}

impl<T> CustomStruct<T> {
    pub fn new() -> Self {}

	pub fn immutable(&self) -> i32 {}

    pub fn mutable(&mut self) -> i32 {}

    pub fn consume_immutable(self) -> i32 {}

    pub fn consume_mutable(mut self) -> i32 {}
}

pub fn main(text: &str, pattern: &str) -> CustomStruct<i32> {
    {
        let mut z = CustomStruct::new(); // z is mutable and has no borrows so can be used to call any method
        let y: i32 = z.??; // accepts all methods since z is mutable and has no borrows
    }

    {
        let z = CustomStruct::new(); // z is immutable and has no borrows so can only call methods that take &self or consume self
        let y: i32 = z.??; // accepts immutable() and consume_immutable() but not mutable() or consume_mutable()
    }

    {
        let mut z = CustomStruct::new(); // z is mutably borrowed so cannot call any methods
        let a = &mut z;
        let y: i32 = z.??; // does not accept any methods
        let r = a; // using a after the borrow to ensure the borrow is still active and z cannot call any methods
    }

    {
        let z = CustomStruct::new(); // z is immutably borrowed so can only call methods that take &self or consume self
        let a = &z;
        let y: i32 = z.??; // accepts immutable() and consume_immutable() but not mutable() or consume_mutable()
        let r = a; // using a after the borrow to ensure the borrow is still active and z cannot call any methods
    }
}