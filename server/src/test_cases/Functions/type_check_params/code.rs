
pub fn immutable(a: &str) -> i32 {}

pub fn mutable(a: &mut str) -> i32 {}

pub fn consume_immutable(a: str) -> i32 {}

pub fn consume_mutable(mut a: str) -> i32 {}


pub fn main() {
    {
        let mut z = ""; // z is mutable and has no borrows so can be used to call any method
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
    }

    {
        let z = ""; // z is immutable and has no borrows so can only call methods that take &self or consume self
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
    }

    {
        let mut z = ""; // z is mutably borrowed so cannot call any methods
        let a = &mut z;
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
        let r = a; // using a after the borrow to ensure the borrow is still active and z cannot call any methods
    }
    
    {
        let z = ""; // z is immutably borrowed so can only call methods that take &self or consume self
        let a = &z;
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
        let r = a; // using a after the borrow to ensure the borrow is still active and z cannot call any methods
    }
}