// Ownership off: the same program as Ownership/live_borrow_on. The owner links from `r` and `r2`
// back to `s` still exist, but checkBorrows no longer consults them, so both borrows are offered.

fn immutable_borrow(s: &String) {}

fn main() {
	let s = String::from("hello");
	let r: &String = &s;
	let r2: &String = &s;

	immutable_borrow(??);

	immutable_borrow(r2);
}
