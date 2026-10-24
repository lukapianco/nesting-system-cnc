# Componentes de terceiros

## Otimizador externo `native/prumo-sparrow` (opcional, ADR 006)

| Componente | Licença | Obrigação | Onde |
|---|---|---|---|
| sparrow 0.3.0 — Jeroen Gardeyn, KU Leuven | MIT | manter o aviso de copyright e o texto da licença | `native/prumo-sparrow/sparrow/LICENSE` |
| jagua-rs 1.1.0 — Jeroen Gardeyn | MPL-2.0 | código-fonte dos arquivos modificados disponível a quem recebe o programa (está no repositório; lista em `PRUMO_MODIFICACOES.md`) | `native/prumo-sparrow/jagua-rs/LICENSE` |
| clipper2-rust 1.2 — Lars Brubaker (port do Clipper2 de Angus Johnson) | Boost 1.0 | aviso só em distribuição de código-fonte | baixado pelo Cargo |
| crates Rust de apoio (rand, rand_distr, rayon, serde, serde_json, itertools, slotmap, ordered-float, float-cmp, log, anyhow, tap, num-traits e dependências) | MIT e/ou Apache-2.0 | manter os avisos ao distribuir o binário | baixados pelo Cargo |

## Dados de benchmark

As instâncias ESICUP usadas em `bench/public/` vêm do repositório do sparrow (`data/input`) e **não são
redistribuídas**: `bench/public/fetch-instances.sh` as baixa na máquina de quem roda o benchmark.

## Servidor Node.js

express, multer e dependências (MIT); `dxf-parser` (MIT) só nos testes. Lista completa em `package-lock.json`.

Isto é leitura técnica das licenças, não parecer jurídico.
