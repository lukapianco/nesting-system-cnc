#![cfg_attr(feature = "simd", feature(portable_simd))]
#![allow(const_item_mutation)]
#![allow(unused_imports)]

use jagua_rs::Instant;
use std::sync::LazyLock;

pub mod optimizer;
pub mod quantify;
pub mod sample;
pub mod util;
pub mod config;
pub mod eval;
pub mod consts;

pub static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Prumo: substitui o formatador do crate numfmt (so usado em mensagens de log).
pub struct Fmt;
impl Fmt {
    pub fn fmt2<T: Into<f64>>(&self, v: T) -> String { format!("{:.3e}", v.into()) }
}
#[allow(non_snake_case)]
pub fn FMT() -> Fmt { Fmt }


pub const EXPORT_LIVE_SVG: bool = false;
pub const EXPORT_ONLY_FINAL_SVG: bool = true;
