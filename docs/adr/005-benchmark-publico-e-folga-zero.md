# ADR 005 — Benchmark público (ESICUP) e correções para folga zero

**Status:** aceito (V5.4) · **Missão:** seção 8 (benchmark obrigatório), Etapa A

## Protocolo

* Instâncias: as 13 da tabela 8.3 da missão (`albano` … `trousers`), baixadas por `bench/public/fetch-instances.sh`
  (repositório JeroenGar/sparrow, MIT — **não** redistribuídas; créditos no script. A V5.4 dizia MPL-2.0 por engano: a MPL é do jagua-rs).
* Problema: strip packing, altura fixa `strip_height`, comprimento livre; objetivo novo **`MIN_STRIP_LENGTH`** no worker
  (mesmo otimizador BRKGA + SA + BLF; só a função de comparação muda). Rotações da instância
  (`{0}` → FIXED_0, `{0,180}` → GRAIN_X, 4 ângulos → ORTHOGONAL). kerf = folga = margem = 0. Sem Part-in-Part.
* Escala: cada instância é multiplicada para altura 1000 (densidade invariante; as tolerâncias do motor são em mm).
* Faixa folgada: 2,5 × (área total ÷ altura). Se nem todas as peças couberem, a **mesma semente** roda de novo com a faixa
  1,6× maior (até 2 vezes) e o fator usado fica registrado (`largura_folga`). Só aconteceu em `shapes0` e `shapes1`, cuja
  densidade atual (~41%) pede mais de 2,44×. O comprimento medido é o usado, não o da faixa, então o fator não muda a
  densidade calculada.
* **Medição independente** (`bench/public/run.js`): densidade = Σ área dos polígonos posicionados ÷ (1000 × maior X
  ocupado), calculada a partir das posições finais, sem usar KPI do motor; validador independente (sobreposição/contato),
  contagem exata de peças e conferência de área. Solução inválida não entra na média.
* Orçamento: 60 s por execução, 5 sementes, 2 execuções em paralelo (1 thread cada), Xeon 2,8 GHz (2 threads).
  Referência: melhor solução publicada pelo sparrow (rodapé dos SVG em `data/records`; "melhor já obtido").

## Defeitos encontrados pelo benchmark (corrigidos)

Ao rodar com folga zero, o validador independente reprovou soluções. Dois defeitos, ambos invisíveis com as folgas
usuais (≥ 0,02 mm), que os presets usam:

1. **Atalho por caixas da colisão** usava "folga − 0,01" em vez da folga mínima efetiva (`max(0,01, folga − 0,01)`):
   iguais para folga ≥ 0,02; com folga 0, caixas podiam se sobrepor 0,01 mm sem o teste exato rodar → micro-sobreposições
   de 0,002–0,004 mm (`fu`, `albano`, `shirts`).
2. **Consulta de vizinhos na R-tree** usava a caixa exata do candidato: `133,32 + 199,98 = 333,29999999999995 < 333,3`
   em double, a peça encostada não era encontrada e o teste de colisão nem rodava → peças encostadas (`blaz1`, `jakobs2`).
   Correção: consulta com 0,02 mm a mais (`QUERY_PAD`); o teste de colisão é exato, então vizinhos extras não mudam
   respostas corretas.

Verificação: teste de propriedade com folgas de 0 a 12 mm (16.000 respostas iguais ao oráculo); teste de regressão
"folga 0" com as medidas do `blaz1` (falha com `QUERY_PAD = 0`, passa com 0,02); `bench/equivalencia.js`: os 12 layouts
de referência com as folgas usuais são **idênticos** com e sem a correção.

## Resultados

Ver `bench/public/results/public_v5.4.0_60s.{csv,json}` (saídas brutas, inclusive curva tempo × comprimento) e a tabela
no CHANGELOG da V5.4 (65/65 válidas; média 37,7–71,8%; 15–39 pp abaixo da referência). Este é o **ponto de partida honesto**: o posicionamento atual (candidatos heurísticos + BLF) fica
longe das referências; o caminho para fechar a diferença está no plano (NFP exato, busca por minimização de sobreposição
e compressão da faixa, multi-start paralelo).

Observação: em `shapes0`/`shapes1` a densidade caiu quando a faixa foi alargada (~41% com peças faltando → ~38% com
todas). A busca atual depende da largura disponível; um otimizador de faixa de verdade (comprime até não caber) não
deveria — critério de aceite da fase 3 do plano.
