pub struct String {

}

impl String {
    pub fn new() -> Self {}
}

fn do_something(s: &mut String) {

}

fn do_something_else(s: &mut String) {

}

fn main() {
    let mut owned = String::new();
    let mutable = &mut owned;

    do_something(??);

    do_something_else(mutable);
}