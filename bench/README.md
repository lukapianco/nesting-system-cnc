# Benchmark A/B (qualidade real, independente do KPI do motor)

`metrics.js` mede qualquer layout com uma **régua raster independente** (2 mm): aproveitamento líquido, retalho útil
total/maior e compacidade do envelope. Não usa nenhum campo calculado pelo motor, então serve para comparar versões.

* `node bench/ab.js` — V5.0 original × V5.x (exige a V5.0 em `V5_DIR`, padrão `/tmp/v5orig`).
* `bench/ab2.js`, `bench/ab3.js` — variantes de configuração (modo de avaliação, rigidez do gene de rotação).

Use **várias sementes**: a busca é estocástica e instâncias pequenas convergem sempre ao mesmo layout.
