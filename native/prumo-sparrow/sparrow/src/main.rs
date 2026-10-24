//! prumo-sparrow: o otimizador sparrow (MIT) como processo externo do Prumo.
//!
//! Uso: prumo-sparrow --input instancia.json --time 60 --seed 7 [--workers 2] [--early] [--budget 400]
//!
//! --budget N (Prumo, V5.7): orçamento em PASSOS em vez de tempo. Um passo = uma consulta ao critério de parada, que o
//! sparrow faz sempre na thread principal e em pontos fixos do algoritmo (a cada rodada do separador e a cada laço de
//! exploração/compressão). Com a mesma instância, semente, --workers e --budget, o resultado é o mesmo em qualquer
//! máquina, rápida ou lenta. 80% dos passos vão para a exploração e 20% para a compressão, como no tempo. --time vira
//! só um teto de segurança: se ele vencer antes do orçamento, o "done" diz reproducible = false.
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// Tempo limite (ou orçamento de passos) + pedido de parada vindo do stdin.
struct StopTerminator {
    timeout: Option<Instant>,
    stop: Arc<AtomicBool>,
    /// modo orçamento: [passos da exploração, passos da compressão]; o tempo vira teto (`deadline`)
    budget: Option<[u64; 2]>,
    deadline: Option<Instant>,
    phase: usize,
    steps: AtomicU64,       // passos da fase atual
    total_steps: AtomicU64, // passos de todas as fases
    time_hit: AtomicBool,
    stop_hit: AtomicBool,
}
impl Terminator for StopTerminator {
    fn kill(&self) -> bool {
        if self.stop.load(Ordering::SeqCst) { self.stop_hit.store(true, Ordering::SeqCst); return true; }
        match self.budget {
            None => {
                let k = self.timeout.is_some_and(|t| Instant::now() > t);
                if k { self.time_hit.store(true, Ordering::SeqCst); } else { self.total_steps.fetch_add(1, Ordering::SeqCst); }
                k
            }
            Some(b) => {
                if self.deadline.is_some_and(|t| Instant::now() > t) { self.time_hit.store(true, Ordering::SeqCst); return true; }
                let limit = b[self.phase.min(1)];
                if self.steps.load(Ordering::SeqCst) >= limit { return true; }
                self.steps.fetch_add(1, Ordering::SeqCst);
                self.total_steps.fetch_add(1, Ordering::SeqCst);
                false
            }
        }
    }
    fn new_timeout(&mut self, timeout: Duration) {
        if self.budget.is_some() {
            // cada fase do sparrow chama new_timeout uma vez, na ordem exploração → compressão
            if self.timeout.is_some() { self.phase += 1; }
            self.steps.store(0, Ordering::SeqCst);
            self.timeout = self.deadline.or(Some(Instant::now() + timeout));
        } else {
            self.timeout = Some(Instant::now() + timeout);
        }
    }
    fn timeout_at(&self) -> Option<Instant> { self.timeout }
    fn budget_progress(&self) -> Option<f32> {
        self.budget.map(|b| self.steps.load(Ordering::SeqCst) as f32 / b[self.phase.min(1)].max(1) as f32)
    }
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

struct Args { input: String, time: f32, seed: u64, workers: Option<usize>, early: bool, budget: Option<u64> }

fn parse_args() -> Result<Args> {
    let mut a = Args { input: String::new(), time: 60.0, seed: 0, workers: None, early: false, budget: None };
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
            "--budget" => { a.budget = Some(next(i)?.parse()?); i += 1; }
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

/// Campo opcional "prumo_sheet": {"outer": [[x,y]...], "holes": [[[x,y]...]...], "offset": d, "shift": [dx,dy]}
/// (coordenadas da chapa). Obstáculo = (caixa da chapa − contorno) ∪ furos, cada um inflado por `offset` (pode ser
/// negativo) e deslocado por `shift` para o referencial da faixa. Entra como zona de qualidade 0 (furo) do contêiner.
fn build_sheet_obstacles(path: &Path, sur: jagua_rs::geometry::fail_fast::SPSurrogateConfig) -> Result<Option<usize>> {
    use clipper2_rust::{area, difference_d, inflate_paths_d, EndType, FillRule, JoinType, PathD, PathsD, Point};
    use jagua_rs::entities::InferiorQualityZone;
    use jagua_rs::geometry::shape_modification::{ShapeModifyConfig, ShapeModifyMode};
    use jagua_rs::geometry::{DTransformation, OriginalShape};
    use jagua_rs::io::ext_repr::ExtSPolygon;
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let Some(sh) = v.get("prumo_sheet") else { return Ok(None) };
    let ring = |r: &serde_json::Value| -> Result<PathD> {
        r.as_array().context("anel inválido")?.iter().map(|p| {
            let a = p.as_array().context("ponto inválido")?;
            Ok(Point::new(a[0].as_f64().context("x")?, a[1].as_f64().context("y")?))
        }).collect()
    };
    let outer = ring(sh.get("outer").context("prumo_sheet.outer ausente")?)?;
    let holes: Vec<PathD> = sh.get("holes").and_then(|h| h.as_array()).map(|hs| hs.iter().map(ring).collect::<Result<Vec<_>>>()).transpose()?.unwrap_or_default();
    let off = sh.get("offset").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let (sx, sy) = sh.get("shift").and_then(|s| s.as_array()).map(|a| (a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0))).unwrap_or((0.0, 0.0));
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in &outer { x0 = x0.min(p.x); y0 = y0.min(p.y); x1 = x1.max(p.x); y1 = y1.max(p.y); }
    let bbox: PathD = vec![Point::new(x0, y0), Point::new(x1, y0), Point::new(x1, y1), Point::new(x0, y1)];
    // área fora do contorno, dentro da caixa da chapa: peças simples (o contorno toca os 4 lados da caixa)
    let mut regions: Vec<(PathD, f64)> = difference_d(&vec![bbox], &vec![outer], FillRule::NonZero, 4).into_iter()
        .filter(|r| area(r).abs() > 1e-6).map(|r| (r, off)).collect();
    regions.extend(holes.into_iter().map(|h| (h, off)));
    // V5.7/V5.8: peças já colocadas nesta chapa (reabastecimento chapa a chapa, ADR 009): contorno nominal em
    // coordenadas da chapa, cada uma com o seu offset (o Prumo manda g, então peça nova e fixa ficam a ≥ 2g ≥ folga)
    if let Some(fx) = sh.get("fixed").and_then(|f| f.as_array()) {
        for f in fx {
            let r = ring(f.get("ring").context("prumo_sheet.fixed[].ring ausente")?)?;
            let o = f.get("offset").and_then(|x| x.as_f64()).unwrap_or(0.0);
            if r.len() >= 3 { regions.push((r, o)); }
        }
    }
    // orientação positiva em todos: um anel horário seria tratado como furo pelo offset (encolheria e sumiria)
    for (r, _) in regions.iter_mut() { if area(r) < 0.0 { r.reverse(); } }
    let mut shapes = Vec::new();
    for (r, off) in regions {
        let grown: PathsD = if off != 0.0 { inflate_paths_d(&vec![r], off, JoinType::Round, EndType::Polygon, 2.0, 4, 0.002) } else { vec![r] };
        for g in grown {
            if area(&g) <= 1e-6 { continue; } // positivo = contorno externo (o offset não cria furos aqui)
            let pts: Vec<(f32, f32)> = g.iter().map(|p| ((p.x + sx) as f32, (p.y + sy) as f32)).collect();
            let shape = jagua_rs::io::import::import_simple_polygon(&ExtSPolygon(pts))?;
            shapes.push(OriginalShape {
                shape,
                pre_transform: DTransformation::empty(),
                modify_mode: ShapeModifyMode::Inflate,
                modify_config: ShapeModifyConfig { simplify_tolerance: None, offset: None, narrow_concavity_cutoff: None },
            });
        }
    }
    if shapes.is_empty() { return Ok(Some(0)); }
    let n = shapes.len();
    let extent = shapes.iter().map(|s| s.shape.bbox().x_max).fold(0.0f32, f32::max);
    let _ = sparrow::PRUMO_OBSTACLE_EXTENT.set(extent);
    let zone = InferiorQualityZone::new(0, shapes, sur)?;
    jagua_rs::probs::spp::entities::PRUMO_STRIP_OBSTACLES.set(zone).map_err(|_| anyhow::anyhow!("obstáculos já definidos"))?;
    Ok(Some(n))
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
    // Prumo: chapa desenhada (contorno irregular e furos) vira obstáculos fixos na faixa
    if let Some(n) = build_sheet_obstacles(Path::new(&args.input), config.cde_config.item_surrogate_config)? {
        eprintln!("[PRUMO] {n} obstáculo(s) fixo(s) da chapa");
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
    let budget = args.budget.map(|n| {
        let n = n.max(2);
        let e = ((n as f64) * DEFAULT_EXPLORE_TIME_RATIO as f64).round() as u64;
        [e.max(1), (n - e.min(n - 1)).max(1)]
    });
    let deadline = budget.map(|_| Instant::now() + total);
    let mut terminator = StopTerminator {
        timeout: None, stop, budget, deadline, phase: 0,
        steps: AtomicU64::new(0), total_steps: AtomicU64::new(0), time_hit: AtomicBool::new(false), stop_hit: AtomicBool::new(false),
    };
    let mut listener = JsonListener { best_width: f32::INFINITY };
    optimize(instance, rng, &mut listener, &mut terminator, &config.expl_cfg, &config.cmpr_cfg, initial.as_ref())?;
    let time_hit = terminator.time_hit.load(Ordering::SeqCst);
    let stop_hit = terminator.stop_hit.load(Ordering::SeqCst);
    emit(&serde_json::json!({
        "type": "done",
        "elapsed_s": EPOCH.elapsed().as_secs_f32(),
        "steps": terminator.total_steps.load(Ordering::SeqCst),
        "budget": args.budget,
        // reproduzível: orçamento de passos e nada de tempo ou parada no meio
        "reproducible": args.budget.is_some() && !time_hit && !stop_hit,
        "time_hit": time_hit,
        "stop_hit": stop_hit
    }));
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        emit(&serde_json::json!({ "type": "error", "message": format!("{e:#}") }));
        std::process::exit(1);
    }
}
