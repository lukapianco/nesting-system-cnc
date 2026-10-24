use crate::collision_detection::CDEConfig;
use crate::entities::{Container, InferiorQualityZone};
use crate::geometry::primitives::{Rect, SPolygon};
use crate::geometry::shape_modification::{ShapeModifyConfig, ShapeModifyMode};
use crate::geometry::{DTransformation, OriginalShape};
use anyhow::{Result, ensure};
use std::sync::OnceLock;

/// Prumo: obstáculos fixos da chapa (furos/defeitos e a área fora de um contorno irregular), em coordenadas da
/// faixa, como zona de qualidade 0 (tratada como furo pelo jagua-rs). Um processo do prumo-sparrow resolve uma única
/// instância, então o valor é definido uma vez, antes da importação, e vale para todas as larguras da faixa.
pub static PRUMO_STRIP_OBSTACLES: OnceLock<InferiorQualityZone> = OnceLock::new();

#[derive(Clone, Debug, Copy, PartialEq)]
/// Represents a rectangular container with fixed height and variable width.
pub struct Strip {
    pub fixed_height: f32,
    pub cde_config: CDEConfig,
    pub shape_modify_config: ShapeModifyConfig,
    pub width: f32,
}

impl Strip {
    pub fn new(
        fixed_height: f32,
        cde_config: CDEConfig,
        shape_modify_config: ShapeModifyConfig,
        width: f32,
    ) -> Result<Self> {
        ensure!(fixed_height > 0.0, "strip height must be positive");
        ensure!(width > 0.0, "strip width must be positive");
        Ok(Strip {
            fixed_height,
            cde_config,
            shape_modify_config,
            width,
        })
    }

    pub fn set_width(&mut self, width: f32) {
        assert!(width > 0.0, "strip width must be positive");
        self.width = width;
    }
}

impl TryFrom<Strip> for Container {
    type Error = anyhow::Error;

    fn try_from(s: Strip) -> Result<Container> {
        // Prumo: só os obstáculos que tocam a faixa atual entram (a faixa encolhe durante a otimização)
        let zones = match PRUMO_STRIP_OBSTACLES.get() {
            Some(z) => {
                let kept = z.filtered(|sh| sh.bbox.x_min < s.width && sh.bbox.x_max > 0.0 && sh.bbox.y_min < s.fixed_height && sh.bbox.y_max > 0.0);
                if kept.shapes_cd().is_empty() { vec![] } else { vec![kept] }
            }
            None => vec![],
        };
        Container::new(
            OriginalShape {
                shape: SPolygon::from(Rect::try_new(0.0, 0.0, s.width, s.fixed_height)?),
                pre_transform: DTransformation::empty(),
                modify_mode: ShapeModifyMode::Deflate,
                modify_config: s.shape_modify_config,
            },
            zones,
            s.cde_config,
        )
    }
}
