struct Container {
    value: i32,
}


fn process(reader: &Container, writer: &mut Container) -> i32 {
    writer.value = reader.value;
    reader.value
}

fn main() {
    let owned = Container { value: 42 };
    let shared: &Container = &owned;
    
    // Fix: Create the owned instance first, then borrow it
    let mut target_container = Container { value: 99 };
    let mutable: &mut Container = &mut target_container;

    let result = process(??, ??);
    println!("{result}");
}