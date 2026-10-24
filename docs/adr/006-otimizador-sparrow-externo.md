# ADR 006 — Otimizador externo sparrow + jagua-rs (processo separado)

**Status:** aceito (V5.5); chapa irregular revista na ADR 007 (V5.6) · **Plano:** fases 2 e 3 (núcleo geométrico exato e busca de estado da arte), portão P2

## Contexto

A V5.4 mediu o motor pela primeira vez (ADR 005): 65 de 65 soluções válidas, mas a densidade média ficou 15 a 39
pontos abaixo dos melhores resultados publicados. O limite era o próprio método: o motor clássico só escolhe ordem e
giro das peças e põe uma de cada vez no canto mais baixo à esquerda (BRKGA + BLF). Peças nunca "abrem espaço" para
outras.

O estudo de repositórios trazido pelo usuário (24/10/2026) conferiu código e licenças e recomendou a pilha Clipper2
→ jagua-rs + sparrow. O sparrow (Gardeyn & Wauters, arXiv 2509.13329) é o estado da arte publicado em strip packing:
deixa as peças se sobreporem e vai empurrando até separá-las, e depois aperta a faixa.

## Decisão

1. **Usar o sparrow 0.3.0 (MIT) + jagua-rs 1.1.0 (MPL-2.0) sem mudar o algoritmo**, compilados num executável próprio
   (`native/prumo-sparrow`) que o Prumo chama como **processo separado**. O código-fonte completo, com a lista do que
   foi tirado ou trocado, está em `native/prumo-sparrow/PRUMO_MODIFICACOES.md`. Fora o novo `main.rs` e as dependências
   retiradas, só mudou o que não altera o resultado: SVG, offset via `geo`, `ndarray`, logger e linha de comando.
2. **Folga aplicada pelo Prumo, não pelo jagua-rs.** Cada peça entra com o contorno externo inflado por
   `g = D_nom/2 + 0,005 mm` (Clipper2, junta redonda, 4 casas, tolerância de arco 0,002 mm). Duas peças infladas que não
   se sobrepõem ficam a pelo menos D_nom. A faixa tem altura `H − 2·b + 2·g` e começa em `(b − g, b − g)` na chapa
   (`b` = margem efetiva). Os 0,005 mm cobrem a corda do arco, o `f32` do otimizador e o arredondamento a 0,001 mm do Prumo.
   Não são folga de projeto.
3. **Furos e Part-in-Part voltam pelo Prumo.** O otimizador só vê o contorno externo. Antes dele, o Prumo encaixa as
   filhas nos furos (mesma rotina do motor clássico) e, depois, aplica a cada filha a transformação da mãe. Métricas,
   retalhos, CAM e validação são exatamente os do motor clássico (`assembleResult` + `finalize`).
4. **O validador independente decide.** Só soluções aprovadas viram resultado. Se nenhuma passa, ou se o otimizador
   falha, o job continua no motor clássico e o motivo vai para a tela (`engineNote`).
5. **Motor `AUTO` (padrão):** usa o sparrow quando o executável existe e o job se encaixa no que ele resolve. Ele não
   resolve chapa desenhada (irregular ou com furos) nem lote que não cabe numa chapa: esses vão para o clássico, com
   aviso. *(V5.6: a chapa desenhada passou a ir para o sparrow; ver ADR 007.)* `CLASSICO` e `SPARROW` forçam a escolha. Sem o executável, nada muda para o usuário além do aviso.
6. **Parada cooperativa:** "Parar e manter o melhor" escreve `stop` no stdin do processo. Se o servidor morre, o stdin
   fecha e o otimizador também para.
7. **Tempo:** com o sparrow, o orçamento é tempo (`time_limit_s`, ou o tempo do modo de qualidade: rascunho 10 s,
   padrão 30 s, produção 120 s), dividido 80% exploração e 20% compressão, como no artigo.

## Medição (régua e protocolo da ADR 005, mesmo hardware, mesma rodada)

Estão em `bench/public/results/public_v5.5.0_60s{,_sparrow}.{json,csv}`: 13 instâncias × 5 sementes × 60 s, 1 thread
por execução, 2 execuções em paralelo, Xeon 2,1 GHz. A tabela comparativa fica no CHANGELOG da V5.5.

- **Sparrow:** 65 de 65 soluções válidas pelo validador independente. Média de 65,6% a 89,8% por instância; a
  distância do melhor resultado para a referência publicada ficou entre 0,3 e 7,3 pontos.
- **Motor clássico, mesma rodada:** média de 37,8% a 71,8% por instância (65 de 65 válidas), igual à medição da V5.4
  em outra CPU.

Em chapas reais (`bench/motores.js`), os dois motores rodam com o mesmo tempo e são comparados pelo comprimento usado
da chapa e pelos retalhos medidos pela régua raster independente (`bench/metrics.js`). Em 10 s, o sparrow usou menos
chapa e deixou retalho maior em 4 de 5 casos; no Modelo 1 foi o único a pôr as 22 peças. O caso que perdeu foi o
Modelo 2 (87 peças com splines), que tem pouco tempo no modo Rascunho; com os 30 s do modo Padrão, ele ganha (2.882,8
contra 2.908,2 mm). Por isso o Automático é o padrão, e o modo Rascunho fica para conferir ideias, como já dizia o
manual.

## Consequências

- **Reprodutibilidade:** com orçamento por tempo, a mesma semente pode dar layouts diferentes em máquinas de
  velocidades diferentes. O motor clássico continua reproduzível por semente e número de avaliações. Um orçamento por
  número de iterações no sparrow fica como trabalho futuro.
- **Implantação:** é preciso compilar o executável para a plataforma do servidor (`npm run build:sparrow`, Rust ≥ 1.90).
  O CI compila e roda os testes com e sem ele.
- **Licença:** a MPL-2.0 obriga a disponibilizar o fonte dos arquivos alterados do jagua-rs, e ele está no repositório.
  O sparrow e o Clipper2 pedem só os avisos (`THIRD_PARTY_NOTICES.md`).
- **Fora do alcance desta decisão** (continua no motor clássico ou no plano): chapa irregular, várias chapas, retalho
  como contêiner, peças em furos com várias filhas, rotação contínua e objetivo de corte (comprimento, perfurações).
- **Ambiente de desenvolvimento desta sessão:** o registro de crates estava bloqueado, então as dependências foram
  montadas a partir das tags oficiais no GitHub, com `[patch]` fora do repositório. O `Cargo.toml` do repositório é o
  normal e compila com `cargo build` comum. O `Cargo.lock` não é versionado, porque o desta sessão aponta para caminhos
  locais.
