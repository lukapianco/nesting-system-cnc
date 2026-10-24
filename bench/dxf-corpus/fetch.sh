#!/usr/bin/env bash
# Baixa DXF públicos de repositórios abertos para o teste de robustez do leitor (fase 1 do plano).
# Os arquivos NÃO são redistribuídos com o Prumo: ficam em bench/dxf-corpus/files (ignorado no git).
#   ezdxf (MIT, Manfred Moitzi) .......... examples_dxf, integration_tests/data, examples/edgeminer
#   dxf-parser (MIT, gdsestimating) ...... samples de teste
#   dxf-viewer (MPL-2.0, SPH Engineering)  test/fixtures (hachuras, cotas, textos, blocos)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p files && cd files
for r in mozman/ezdxf gdsestimating/dxf-parser vagran/dxf-viewer; do
  d=$(basename "$r")
  [ -d "$d" ] || git clone -q --depth 1 "https://github.com/$r" "$d"
done
echo "DXF encontrados: $(find . -iname '*.dxf' | wc -l)"
