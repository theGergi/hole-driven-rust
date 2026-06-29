use std::vec::Vec;


fn has_close_elements(numbers:Vec<f32>, threshold: f32) -> bool{

    for i in 0..numbers.len(){
        for j in 1..numbers.len() {

            if i != j {
                let distance:f32 = numbers[i] - ??;

                if distance.abs() < threshold{
                    return true;
                }

            }

        }
    }

    return false;
}