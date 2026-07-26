// Calling a method that takes `self` by value consumes the receiver.
// After `a.consume()`, `a` is moved and must not be suggested; only the
// untouched `b` and the associated function remain.

struct Widget {
    id: i32,
}

impl Widget {
    fn new() -> Self {}
    fn consume(self) -> i32 {}
}

fn main() {
    let a = Widget { id: 1 };
    let b = Widget { id: 2 };
    let used: i32 = a.consume();
    let w: Widget = ??;
}
