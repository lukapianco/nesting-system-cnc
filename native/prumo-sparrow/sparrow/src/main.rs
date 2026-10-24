//! prumo-sparrow: o otimizador sparrow (MIT) como processo externo do Prumo.
//!
//! Uso: prumo-sparrow --input instancia.json --time 60 --seed 7 [--workers 2] [--early]
//!
//! Entrada: instância de strip packing no formato JSON do jagua-rs (ExtSPInstance).
//! Saída (stdout, uma linha JSON por evento):
//!   {"type":"solution","phase":"expl"|"cmpr"|"final","elapsed_s":..,"solution":ExtSPSolution}
//!   {"type":"done","elapsed_s":..}  ou  {"type":"error","message":".."}
//! Cada "solution" é viável segundo o próprio sparrow; o Prumo reconfere TUDO com o validador independente.
//! Parada cooperativa: escrever "stop" no stdin (ou fechá-lo). O otimizador encerra a fase atual e emite a solução final.
//! Logs de progresso vão para stderr.

use anyhow::{bail, Context, Result};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::SPSolution;
use jagua_rs::Instant;
use log::{Level, LevelFilter, Log, Metadata, Record};
use rand::rngs::Xoshiro256PlusPlus;
use rand::SeedableRng;
use serde::Serialize;
use sparrow::config::*;
use sparrow::consts::{DEFAULT_COMPRESS_TIME_RATIO, DEFAULT_EXPLORE_TIME_RATIO, DEFAULT_FAIL_DECAY_RATIO_CMPR, DEFAULT_MAX_CONSEQ_FAILS_EXPL};
use sparrow::optimizer::optimize;
use sparrow::util::io;
use sparrow::util::listener::{ReportType, SolutionListener};
use sparrow::util::terminator::Terminator;
use sparrow::EPOCH;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

static OUT: LazyLock<Mutex<std::io::Stdout>> = LazyLock::new(|| Mutex::new(std::io::stdout()));

fn emit(v: &impl Serialize) {
    let line = serde_json::to_string(v).expect("json");
    let mut o = OUT.lock().unwrap();
    let _ = writeln!(o, "{line}");
    let _ = o.flush();
}

struct StderrLogger;
impl Log for StderrLogger {
    fn enabled(&self, m: &Metadata) -> bool { m.level() <= Level::Info }
    fn log(&self, r: &Record) {
        if self.enabled(r.metadata()) {
            eprintln!("[{:>7.2}s] {}", EPOCH.elapsed().as_secs_f32(), r.args());
        }
    }
    fn flush(&self) {}
}
static LOGGER: StderrLogger = StderrLogger;

/// Tempo limite + pedido de parada vindo do stdin.
struct StopTerminator { timeout: Option<Instant>, stop: Arc<AtomicBool> }
impl Terminator for StopTerminator {
    fn kill(&self) -> bool {
        self.stop.load(Ordering::SeqCst) || self.timeout.is_some_and(|t| Instant::now() > t)
    }
    fn new_timeout(&mut self, timeout: Duration) { self.timeout = Some(Instant::now() + timeout); }
    fn timeout_at(&self) -> Option<Instant> { self.timeout }
}

#[derive(Serialize)]
struct SolutionMsg<'a> { r#type: &'a str, phase: &'a str, elapsed_s: f32, solution: jagua_rs::probs::spp::io::ext_repr::ExtSPSolution }

/// Emite cada solução viável que melhora a largura da faixa.
struct JsonListener { best_width: f32 }
impl SolutionListener for JsonListener {
    fn report(&mut self, report: ReportType, solution: &SPSolution) {
        let phase = match report {
            ReportType::ExplFeas => "expl",
            ReportType::CmprFeas => "cmpr",
            ReportType::Final => "final",
            _ => return, // soluções inviáveis não saem do processo
        };
        let w = solution.strip_width();
        if report != ReportType::Final && w >= self.best_width { return; }
        self.best_width = self.best_width.min(w);
        emit(&SolutionMsg { r#type: "solution", phase, elapsed_s: EPOCH.elapsed().as_secs_f32(), solution: jagua_rs::probs::spp::io::export(solution, *EPOCH) });
    }
}

struct Args { input: String, time: f32, seed: u64, workers: Option<usize>, early: bool }

fn parse_args() -> Result<Args> {
    let mut a = Args { input: String::new(), time: 60.0, seed: 0, workers: None, early: false };
    let v: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < v.len() {
        let next = |i: usize| v.get(i + 1).cloned().context(format!("faltou o valor de {}", v[i]));
        match v[i].as_str() {
            "--input" | "-i" => { a.input = next(i)?; i += 1; }
            "--time" | "-t" => { a.time = next(i)?.parse()?; i += 1; }
            "--seed" | "-s" => { a.seed = next(i)?.parse()?; i += 1; }
            "--workers" => { a.workers = Some(next(i)?.parse()?); i += 1; }
            "--early" | "-x" => { a.early = true; }
            other => bail!("argumento desconhecido: {other}"),
        }
        i += 1;
    }
    if a.input.is_empty() { bail!("uso: prumo-sparrow --input instancia.json --time 60 --seed 1 [--workers N] [--early]"); }
    if !(a.time > 0.0) { bail!("--time deve ser > 0"); }
    Ok(a)
}

/// Campo opcional "prumo_inflate" (mm): cada peça é inflada por esse valor antes do nesting.
fn read_prumo_inflate(path: &Path) -> Result<f32> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let d = v.get("prumo_inflate").and_then(|x| x.as_f64()).unwrap_or(0.0);
    if !(d.is_finite() && d >= 0.0) { bail!("prumo_inflate inválido: {d}"); }
    Ok(d as f32)
}

/// Infla o contorno externo de cada item por `d` com junta redonda (Clipper2, 4 casas decimais).
/// A tolerância do arco (0,002) fica abaixo da margem de segurança que o Prumo soma a `d`, então o polígono
/// inflado nunca fica menor que o offset exato além dessa margem.
fn inflate_items(inst: &mut jagua_rs::probs::spp::io::ext_repr::ExtSPInstance, d: f32) -> Result<()> {
    use clipper2_rust::{inflate_paths_d, area, EndType, JoinType, PathD, PathsD, Point};
    use jagua_rs::io::ext_repr::{ExtSPolygon, ExtShape};
    for it in inst.items.iter_mut() {
        let pts: Vec<(f32, f32)> = match &it.base.shape {
            ExtShape::SimplePolygon(sp) => sp.0.clone(),
            ExtShape::Polygon(p) => p.outer.0.clone(),
            ExtShape::Rectangle { x_min, y_min, width, height } => vec![(*x_min, *y_min), (x_min + width, *y_min), (x_min + width, y_min + height), (*x_min, y_min + height)],
            ExtShape::MultiPolygon(_) => bail!("item {}: multipolígono não suportado", it.base.id),
        };
        let path: PathD = pts.iter().map(|&(x, y)| Point::new(x as f64, y as f64)).collect();
        let out: PathsD = inflate_paths_d(&vec![path], d as f64, JoinType::Round, EndType::Polygon, 2.0, 4, 0.002);
        let best = out.into_iter().max_by(|a, b| area(a).abs().partial_cmp(&area(b).abs()).unwrap())
            .context(format!("item {}: offset vazio", it.base.id))?;
        it.base.shape = ExtShape::SimplePolygon(ExtSPolygon(best.iter().map(|p| (p.x as f32, p.y as f32)).collect()));
    }
    Ok(())
}

fn run() -> Result<()> {
    let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(LevelFilter::Info));
    LazyLock::force(&EPOCH);
    let args = parse_args()?;

    let mut config = DEFAULT_SPARROW_CONFIG;
    let total = Duration::from_secs_f32(args.time);
    config.expl_cfg.time_limit = total.mul_f32(DEFAULT_EXPLORE_TIME_RATIO);
    config.cmpr_cfg.time_limit = total.mul_f32(DEFAULT_COMPRESS_TIME_RATIO);
    if args.early {
        config.expl_cfg.max_conseq_failed_attempts = Some(DEFAULT_MAX_CONSEQ_FAILS_EXPL);
        config.cmpr_cfg.shrink_decay = ShrinkDecayStrategy::FailureBased(DEFAULT_FAIL_DECAY_RATIO_CMPR);
    }
    if let Some(w) = args.workers {
        let w = w.max(1);
        config.expl_cfg.separator_config.n_workers = w;
        config.cmpr_cfg.separator_config.n_workers = w;
    }
    let rng = Xoshiro256PlusPlus::seed_from_u64(args.seed);

    let (mut ext_instance, ext_solution) = io::read_spp_input(Path::new(&args.input))?;
    // Prumo: folga entre peças aplicada AQUI (Clipper2, junta redonda), não pelo jagua-rs (min_item_separation = 0)
    let inflate = read_prumo_inflate(Path::new(&args.input))?;
    if inflate > 0.0 {
        if ext_instance.min_item_separation != 0.0 { bail!("use prumo_inflate OU min_item_separation, não os dois"); }
        inflate_items(&mut ext_instance, inflate)?;
    }
    let importer = Importer::new(config.cde_config, config.poly_simpl_tolerance, config.narrow_concavity_cutoff_ratio);
    let instance = jagua_rs::probs::spp::io::import_instance(&importer, &ext_instance)?;
    let initial = ext_solution.map(|e| jagua_rs::probs::spp::io::import_solution(&instance, &e)).transpose()?;

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            // "stop" ou fim do stdin (o processo pai morreu) = parar e entregar a melhor solução
            for line in stdin.lock().lines() {
                match line { Ok(l) if l.trim() == "stop" => break, Ok(_) => {}, Err(_) => break }
            }
            stop.store(true, Ordering::SeqCst);
        });
    }
    let mut terminator = StopTerminator { timeout: None, stop };
    let mut listener = JsonListener { best_width: f32::INFINITY };
    optimize(instance, rng, &mut listener, &mut terminator, &config.expl_cfg, &config.cmpr_cfg, initial.as_ref())?;
    emit(&serde_json::json!({ "type": "done", "elapsed_s": EPOCH.elapsed().as_secs_f32() }));
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        emit(&serde_json::json!({ "type": "error", "message": format!("{e:#}") }));
        std::process::exit(1);
    }
}
