
pub fn immutable(a: &String) -> i32 {}

pub fn mutable(a: &mut String) -> i32 {}

pub fn consume_immutable(a: String) -> i32 {}

pub fn consume_mutable(mut a: String) -> i32 {}


pub fn main() {
    {
        let mut z = String::from(""); // z is mutable and has no borrows so can be used to call any method
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
    }

    {
        let z = String::from(""); // z is immutable and has no borrows so can only call methods that take &self or consume self
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
    }

    {
        let mut z = String::from(""); // z is mutably borrowed so cannot call any methods
        let a = &mut z;
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
        let r = a; // using a after the borrow to ensure the borrow is still active and z cannot call any methods
    }
    
    {
        let z = String::from(""); // z is immutably borrowed so can only call methods that take &self or consume self
        let a = &z;
        immutable(??);
        mutable(??);
        consume_immutable(??);
        consume_mutable(??);
        let r = a; // using a after the borrow to ensure the borrow is still active and z cannot call any methods
    }
}