# ADR 008 — Várias buscas em paralelo e resultado reproduzível no otimizador sparrow

**Status:** aceito (V5.7); divisão de threads revista na V5.8 (medição com 12 threads) · **Plano:** fase 3 (multi-start e orçamento por iterações) · **Complementa:** ADR 006 e 007

## Contexto

O benchmark longo da V5.6 mostrou que, em algumas instâncias, mais tempo não ajuda: o jakobs2 ficou em 80,40% com
60 s e com 300 s, e as três sementes de 60 s pararam no mesmo valor. A referência publicada é a melhor de muitas
rodadas. O próximo ganho barato era rodar várias sementes ao mesmo tempo e ficar com a melhor.

Havia dois problemas junto:

* O servidor dava ao otimizador `núcleos ÷ (núcleos − 1)` threads por job, o que dá 1 thread numa máquina de 12.
  Num servidor de bancada, com um job por vez, quase toda a CPU ficava parada.
* Com orçamento por tempo, a mesma semente dá planos diferentes em máquinas diferentes (ADR 006, "Consequências").
  Para auditoria e suporte, um plano aprovado precisa poder ser refeito.

## Decisão

1. **Threads por job:** as threads lógicas da máquina divididas pelos jobs rodando agora (`PRUMO_THREADS_PER_JOB`
   fixa o número para servidor compartilhado).
2. **Várias buscas independentes:** as threads do job viram K processos `prumo-sparrow`, cada um com a sua semente e
   W threads. A busca 0 usa a semente pedida; as outras, `semente + i × 100003`, para que "Calcular de novo"
   (semente + 1) não repita buscas. Vale a menor faixa entre as buscas; empate fica com a busca de menor índice.
   As alternativas da tela passam a vir de todas as buscas, então mostram arranjos de fato diferentes.
3. **Divisão automática:** buscas de 2 threads (`splitThreads`). Com 2 threads, a medição abaixo favoreceu uma busca
   de 2 threads; com 12 threads ainda não há medição, e o `bench/paralelo.js` existe para isso.
4. **Orçamento em passos (modo reproduzível):** o executável aceita `--budget N`. Um passo é uma consulta ao critério
   de parada, que o sparrow faz só na thread principal e em pontos fixos do algoritmo. A compressão usava o tempo
   decorrido para decidir o tamanho do encolhimento; no modo de passos ela usa a fração de passos já gasta (o resto
   do algoritmo não muda). Com a mesma instância, semente, threads por busca e orçamento, o plano é o mesmo em
   qualquer máquina. O tempo vira só teto de segurança: se vencer antes, o plano sai, mas a tela avisa que pode não
   se repetir.
5. **Divisão fixa no modo reproduzível:** 2 buscas × 2 threads, em qualquer servidor. Numa máquina com menos de 4
   threads o modo só demora mais; o plano é o mesmo.
6. **Passos por modo** (medido: uma busca de 2 threads faz ~18 passos/s num Xeon de 2,1 GHz): Rascunho 180,
   Padrão 540, Produção 2.160. Teto de tempo: 8 × o tempo do modo (mínimo 60 s), ou o *Limite (s)* da tela.

## Medição

**Divisão das threads (2 threads, 60 s, 3 sementes, `bench/paralelo.js`):**

| Instância | 1 busca × 2 threads | 2 buscas × 1 thread |
|---|---|---|
| jakobs2 | 80,40 | 80,59 |
| swim | 75,24 | 75,06 |
| blaz1 | 82,39 | 81,24 |
| shapes1 | 72,72 | 72,15 |
| média | 77,69 | 77,26 |

Com só 2 threads, dividir não compensou. Mas a única rodada de jakobs2 que passou do platô de 80,40 (81,32) veio de
uma busca de 1 thread com outra semente. Com 12 threads, a pergunta é outra (uma busca de 12 threads ou 6 buscas de
2) e precisa ser medida numa máquina com 12 threads; o arquivo do `bench/paralelo.js` vai para
`bench/public/results/paralelo/`.

**Reprodutibilidade:** a mesma instância (swim, 200 passos, semente 1) deu o mesmo plano, byte a byte, com o processo
livre e preso a 1 núcleo, e com 2 threads livre e preso a 1 núcleo (de 1,2 s a 3,4 s de relógio). O teste
`test/engine_sparrow.js` roda o mesmo job duas vezes, com 2 e com 1 thread no servidor, e compara as posições.

**Custo do modo reproduzível (2 threads nesta máquina, 900 passos):** Modelo 3 114 s, trueshape 130 s, Modelo 1
182 s (passou do teto de 180 s e foi avisado). Por isso o Padrão ficou com 540 passos.

**Platô do jakobs2:** não é a margem de segurança do Prumo. O sparrow puro, sem folga, na mesma escala, deu 81,43 e
80,39 com as sementes 1 e 2; com a folga de segurança, 80,39 e 80,40; testada uma junta em quina no lugar da redonda,
80,39 e 81,48. A diferença está dentro do que a semente muda, então nada foi alterado.

## Consequências

- O modo por tempo continua sendo o padrão (resultado melhor por segundo). O reproduzível é uma opção na tela
  ("Resultado reproduzível", com a semente visível e editável).
- Reprodutível vale para o mesmo executável e a mesma plataforma. Entre Windows e Linux, funções matemáticas da
  biblioteca do sistema podem diferir na última casa; isso não foi medido.
- A mudança no sparrow é pequena e está em `PRUMO_MODIFICACOES.md`: o critério de parada informa a fração do
  orçamento usada (`budget_progress`), e a compressão usa essa fração quando ela existe. Sem `--budget`, nada muda.

## Revisão V5.8: divisão medida com 12 threads

O usuário rodou o `bench/paralelo.js` num Intel Core i5-12400 (6 núcleos, 12 threads; 11 threads no teste, 60 s,
3 sementes, 4 instâncias). Arquivo: `bench/public/results/paralelo/paralelo_12th_Gen_Intel_R_Core_TM_i5_12400_11t_60s.json`.

| Instância | 1 × 11 | 11 × 1 | 5 × 2 | 3 × 3 | 2 × 4 |
|---|---|---|---|---|---|
| jakobs2 | 83,09 | 80,40 | 81,79 | 82,88 | 82,39 |
| swim | 75,38 | 75,05 | 75,94 | **76,66** | 76,11 |
| blaz1 | 82,61 | 81,78 | **82,94** | 82,69 | 82,58 |
| shapes1 | 73,39 | 72,90 | 74,31 | **74,34** | 73,66 |
| média | 78,62 | 77,53 | 78,75 | **79,14** | 78,69 |

* Buscas de 3 threads ganharam na média (+0,5 ponto sobre uma busca só com 11 threads, +1,6 sobre 11 buscas de 1).
  Com 3 sementes por configuração, as diferenças entre 3×3, 5×2 e 2×4 são pequenas; a de 11×1 é clara.
* Nova política automática: buscas de 3 threads (`k = ⌊t/3⌋`, as threads que sobram vão para as buscas). 12 threads
  = 4 buscas de 3; 2 threads = 1 busca de 2 (o que a medição de 2 threads já indicava).
* O modo reproduzível passa a 2 buscas × 3 threads (era 2 × 2). Os passos por modo continuam os mesmos; numa máquina
  com menos de 6 threads ele demora mais.
* Na mesma máquina, com 11 threads e 60 s, o jakobs2 passou do platô de 80,40 (83,09 com uma busca de 11 threads):
  com mais threads por busca (e mais buscas), o platô some; nesta máquina de 2 threads ele não sumia nem com 300 s.
