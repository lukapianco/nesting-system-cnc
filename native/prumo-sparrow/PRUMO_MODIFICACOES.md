# prumo-sparrow — o que foi copiado e o que mudou

Este diretório traz o **código-fonte completo** de dois projetos de Jeroen Gardeyn (KU Leuven), usados pelo Prumo
como otimizador externo (ADR 006):

| Pasta | Origem | Versão | Licença |
|---|---|---|---|
| `sparrow/` | https://github.com/JeroenGar/sparrow | 0.3.0, commit `1fe3e31` (13/10/2026) | MIT (`sparrow/LICENSE`) |
| `jagua-rs/` | https://github.com/JeroenGar/jagua-rs | 1.1.0, tag `v1.1.0` | MPL-2.0 (`jagua-rs/LICENSE`) |

Artigos: jagua-rs, arXiv 2508.08341; sparrow, arXiv 2509.13329. Os resultados de qualidade são dos autores; o Prumo
só mede, com a régua dele, o que esse código faz no hardware dele (`bench/public/`).

A MPL-2.0 exige que o código-fonte dos **arquivos do jagua-rs modificados** fique disponível a quem recebe o programa.
Ele está aqui, inteiro. O resto do Prumo continua sob a licença do Prumo.

## Mudanças no jagua-rs 1.1.0 (cópia reduzida; nenhuma muda o algoritmo de colisão)

| Arquivo | Mudança | Motivo |
|---|---|---|
| `Cargo.toml` | dependências explícitas; saem `geo`, `geo-types`, `ndarray`, `svg`, `thiserror`, `document-features`, `web-time`, `getrandom`, `rand_distr` | menos dependências para compilar e auditar |
| `src/lib.rs` | `Instant = std::time::Instant` (era `web_time::Instant`); sem a doc gerada por `document-features` | o Prumo não roda o otimizador no navegador |
| `src/io/mod.rs` | módulo `svg` removido (pasta `src/io/svg/` apagada) | desenho SVG não é usado; o Prumo desenha o layout |
| `src/geometry/shape_modification.rs` | `offset_shape` passa a devolver erro em vez de usar `geo::Buffer` | a folga é aplicada pelo Prumo com Clipper2 antes da importação; `min_item_separation` fica 0 |
| `src/geometry/fail_fast/piers.rs` | `ndarray::Array::linspace` trocado por uma função `linspace` local equivalente | sem `ndarray` |
| `src/entities/layout.rs` | `ContainerMismatch` com `Display`/`Error` escritos à mão | sem `thiserror` |
| vários | `rand_distr::num_traits` → `num_traits` | dependência direta |
| `src/probs/spp/entities/strip.rs`, `src/probs/spp/entities/mod.rs` | **V5.6:** `PRUMO_STRIP_OBSTACLES` (`OnceLock<InferiorQualityZone>`); ao montar o contêiner da faixa, as formas dessa zona que tocam a faixa entram como zona de qualidade 0 | chapa desenhada (irregular): o que fica fora do contorno e os furos/defeitos viram obstáculos fixos. O mecanismo de zonas de qualidade e a detecção de colisão com elas já existiam no jagua-rs; só passamos a preenchê-lo |

## Mudanças no sparrow 0.3.0

| Arquivo | Mudança |
|---|---|
| `Cargo.toml` | pacote `prumo-sparrow`, biblioteca continua `sparrow`; saem `clap`, `fern`, `jiff`, `numfmt`, `num_cpus`, `svg`, `ctrlc`, `crossterm`, `ratatui`; entra `clipper2-rust` (Boost 1.0) |
| `src/main.rs` | **novo**: CLI do Prumo (`--input`, `--time`, `--seed`, `--workers`, `--early`), soluções como linhas JSON no stdout, parada por `stop`/fim do stdin, campo `prumo_inflate` (offset Clipper2, junta redonda, 4 casas, tolerância de arco 0,002) |
| `src/cli.rs`, `src/bench.rs`, `src/tui*`, `src/util/svg_exporter.rs`, `src/util/ctrlc_terminator.rs`, `tests/` | removidos (interface própria do sparrow) |
| `src/util/io.rs` | sem `MainCli`, sem logger `fern`, sem gravação de SVG |
| `src/lib.rs` | formatador `FMT()` local no lugar do `numfmt` (só aparece em mensagens de log) |
| `src/consts.rs`, `src/util/assertions.rs` | sem as opções de desenho SVG |
| `src/main.rs` (V5.6) | campo `prumo_sheet` (`outer`, `holes`, `offset`, `shift`): obstáculos = (caixa − contorno) ∪ furos, anéis em sentido horário invertidos antes do offset, inflados por `b − g` com Clipper2 e deslocados para a faixa; vão para `PRUMO_STRIP_OBSTACLES` antes da importação |
| `src/quantify/tracker.rs`, `src/eval/collision_loss.rs` (V5.6) | colisão com `Hole`/`InferiorQualityZone` passa a somar à perda de contêiner `quantify_collision_poly_poly(peça, obstáculo)` (mesma medida usada entre duas peças); a perda de borda vira `+=`; função pública `static_hazard_shape` |
| `src/util/assertions.rs` (V5.6) | a conferência de depuração soma perda de borda e de obstáculos |
| `src/main.rs` (V5.7) | `--budget N`: orçamento em passos (consultas ao critério de parada, sempre na thread principal), 80% exploração e 20% compressão; o tempo vira teto; o `done` informa `steps` e `reproducible` |
| `src/util/terminator.rs`, `src/optimizer/compress.rs` (V5.7) | método `budget_progress()` no `Terminator` (padrão `None`); com orçamento em passos, o tamanho do encolhimento da compressão segue a fração de passos usada em vez da fração de tempo. Sem `--budget`, idêntico ao original |

O algoritmo (construção LBF, exploração, compressão, separador com GLS, busca por amostragem e descida de
coordenadas, função de perda por polos) **não foi alterado**. A única mudança de comportamento é da V5.6: no original,
uma peça sobre um obstáculo fixo era marcada como colisão mas não tinha perda proporcional (o separador não sabia "para
onde empurrar"); agora a sobreposição com o obstáculo é medida com a mesma função usada entre duas peças. Sem chapa
desenhada (sem obstáculos), o comportamento é idêntico ao anterior. Na V5.7, o orçamento em passos (`--budget`) troca o relógio
por uma contagem; sem essa opção, o comportamento também é idêntico.

## Compilar

```bash
cargo build --release --manifest-path native/prumo-sparrow/Cargo.toml
# executável: native/prumo-sparrow/target/release/prumo-sparrow(.exe)
```

Requer Rust 1.90 ou mais novo. Sem o executável o Prumo funciona normalmente com o motor clássico; o modo
"Automático" passa a usar o sparrow assim que o executável existir (ou `PRUMO_SPARROW_BIN` apontar para ele).
