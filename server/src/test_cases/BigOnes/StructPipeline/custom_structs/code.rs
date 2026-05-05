pub struct CustomStruct_3 {}

impl CustomStruct_3 {
    pub fn special_method(&self) {}
}

pub struct CustomStruct_2 {}

impl CustomStruct_2 {
    pub fn to_custom_struct_3(&self) -> CustomStruct_3 {}
}

pub struct CustomStruct_1 {}

impl CustomStruct_1 {
    pub fn new() -> Self {}

    pub fn to_custom_struct_2(&self) -> CustomStruct_2 {}
}


fn special_method(obj: &CustomStruct_3) {}

fn main() {
    let obj_1 = CustomStruct_1::new();
    let obj_2 = obj_1.to_custom_struct_2();
    let obj_3 = obj_2.to_custom_struct_3();

    special_method(??);
}