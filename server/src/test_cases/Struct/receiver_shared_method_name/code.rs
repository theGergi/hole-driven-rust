// Two structs define a method with the same name. The hole is the receiver of
// area(&self), so only values whose type provides area() may fill it. name (a
// String) and main() (returns ()) have no area() and must not be suggested.

struct Circle { r: f64 }
struct Square { side: f64 }

impl Circle {
    fn area(&self) -> f64 { 3.14 * self.r * self.r }
}

impl Square {
    fn area(&self) -> f64 { self.side * self.side }
}

fn main() {
    let c = Circle { r: 1.0 };
    let name = String::from("x");
    let a: f64 = ??.area();
}
