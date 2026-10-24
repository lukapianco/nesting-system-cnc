#!/usr/bin/env bash
# Baixa as instâncias públicas de nesting (ESICUP, convertidas para JSON) e as melhores soluções publicadas.
# Repositório sob licença MIT (o jagua-rs é MPL-2.0); os arquivos de dados NÃO são redistribuídos com o Prumo; ficam em bench/public/instances (ignorado no git).
# Créditos: JeroenGar/jagua-rs e JeroenGar/sparrow — "An open-source heuristic to reboot 2D nesting research"
# (arXiv:2509.13329). Instâncias originais: ESICUP (EURO Special Interest Group on Cutting and Packing).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/instances"
mkdir -p "$DIR"
if [ ! -d "$DIR/sparrow" ]; then git clone --depth 1 https://github.com/JeroenGar/sparrow "$DIR/sparrow"; fi
echo "Instâncias: $DIR/sparrow/data/input  |  Referências: $DIR/sparrow/data/records"
