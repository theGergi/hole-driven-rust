// Represents the final processed state
pub struct GrayscaleImage {
    pub pixels: Vec<u8>,
}

// Represents the raw pixel data in memory
pub struct ImageBuffer {
    pub raw_data: Vec<u8>,
}

impl ImageBuffer {
    // Transitions to the final stage: Processing the image
    pub fn to_grayscale(&self) -> GrayscaleImage {
        println!("Converting buffer to grayscale...");
        GrayscaleImage {
            pixels: vec![128, 128, 128],
        }
    }
}

// Represents a raw file path on disk
pub struct FilePath {
    pub path: String,
}

impl FilePath {
    pub fn new(path: &str) -> Self {
        Self {
            path: path.to_string(),
        }
    }

    // Transitions to the next stage: Loading the file
    pub fn to_image_buffer(&self) -> ImageBuffer {
        println!("Loading bytes from {}...", self.path);
        ImageBuffer {
            raw_data: vec![255, 128, 64],
        }
    }
}

// Standalone function requiring a reference to the final struct
fn run_edge_detection(image: &GrayscaleImage) {
    println!("Running edge detection algorithm on {} pixels...", image.pixels.len());
}

fn main() {
    // 1. Initialize FilePath
    let obj_1 = FilePath::new("photo.jpg");

    // 2. Transform FilePath -> ImageBuffer
    let obj_2 = obj_1.to_image_buffer();

    // 3. Transform ImageBuffer -> GrayscaleImage
    let obj_3 = obj_2.to_grayscale();

    run_edge_detection(??);
}