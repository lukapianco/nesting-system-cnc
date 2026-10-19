// rust-engine/src/lib.rs
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn is_point_in_polygon_wasm(px: f64, py: f64, coords: &[f64]) -> bool {
    let n = coords.len() / 2;
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let xi = coords[i * 2];
        let yi = coords[i * 2 + 1];
        let xj = coords[j * 2];
        let yj = coords[j * 2 + 1];
        let intersect = ((yi > py) != (yj > py))
            && (px < (xj - xi) * (py - yi) / ((yj - yi).max(1e-9)) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}