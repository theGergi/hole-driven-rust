struct Container {
    value: integer,
}

fn process(reader: &Container, writer: &mut Container) -> integer {
    writer.value = reader.value;
    writer.value
}

fn print_value(borrow: &Container) {
    println!("Loading bytes from {}...", borrow.value);
}

fn main() {
    // Create an object and immutable reference
    let owned = Container { value: 42 };
    let shared: &Container = &owned;

    // Create a second mutable object with a mutable reference
    let mut target_container = Container { value: 99 };
    let mutable: &mut Container = &mut target_container;

    let result = process(??, ??);

    println!("{result}");

    // Use the references after the hole so they are not dropped out of scope
    print_value(shared);
    print_value(mutable);
}