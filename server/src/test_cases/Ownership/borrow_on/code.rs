// Ownership on (the default): `r` holds an immutable borrow of `s` that is still used after the
// hole, so no mutable borrow of `s` can be offered. This is the checkBorrows liveness path rather
// than the consumed/borrows flags — see the paired Ownership/borrow_off.

fn immutable_borrow(s: &String) {}

fn mutable_borrow(s: &mut String) {}

fn main() {
	let mut s = String::from("hello");
	let r: &String = &s;

	mutable_borrow(??);

	immutable_borrow(r);
}
