// Ownership off: the same program as Ownership/borrow_on. With borrow tracking disabled the
// outstanding immutable borrow in `r` no longer blocks anything, so `&mut s` is offered.

fn immutable_borrow(s: &String) {}

fn mutable_borrow(s: &mut String) {}

fn main() {
	let mut s = String::from("hello");
	let r: &String = &s;

	mutable_borrow(??);

	immutable_borrow(r);
}
