# Prumo — Manual de Operação e Implantação

> *Prumo* é o nome do motor de nesting (antes "Motor Industrial de True Shape 2D Nesting", V5.x). A API e os arquivos não mudaram de nome.

**Versão do sistema:** 5.8 · **Público:** (A) operador / programador de corte · (B) profissional que faz a implantação na empresa cliente

> **Como ler este manual.** Quem só vai operar o sistema lê os capítulos 1 a 8 e usa o 12 (problemas) como consulta.
> Quem vai implantar na empresa lê tudo, principalmente o capítulo 13 (roteiro de implantação).
> Valores numéricos sugeridos são **pontos de partida**. Máquina, bico, gás, potência, material e lote mudam o resultado: **valide sempre com um corte de teste** (capítulo 7).

---

## Sumário

1. [O que o sistema faz e como pensa](#1-o-que-o-sistema-faz-e-como-pensa)
2. [Fluxo de trabalho em 8 passos](#2-fluxo-de-trabalho-em-8-passos)
3. [Preparando os arquivos DXF](#3-preparando-os-arquivos-dxf)
4. [Lendo a tela](#4-lendo-a-tela)
5. [Referência completa dos parâmetros](#5-referência-completa-dos-parâmetros)
6. [Receitas por cenário](#6-receitas-por-cenário)
7. [Como obter máxima precisão](#7-como-obter-máxima-precisão)
8. [Indicadores (KPIs): o que cada número significa](#8-indicadores-kpis-o-que-cada-número-significa)
9. [Validação independente e CAM: pierce, lead-in e sequência](#9-validação-independente-e-cam-pierce-lead-in-e-sequência)
10. [Exportação do DXF para a máquina](#10-exportação-do-dxf-para-a-máquina)
11. [Boas práticas de produção](#11-boas-práticas-de-produção)
12. [Solução de problemas](#12-solução-de-problemas)
13. [Roteiro de implantação na empresa cliente](#13-roteiro-de-implantação-na-empresa-cliente)
14. [Limitações conhecidas (leia antes de prometer algo ao cliente)](#14-limitações-conhecidas)
15. [Glossário](#15-glossário)
16. [Anexo: valores iniciais por processo](#16-anexo-valores-iniciais-por-processo)

---

## 1. O que o sistema faz e como pensa

O sistema recebe um arquivo **.DXF com as peças** (e, opcionalmente, outro **.DXF com a chapa**) e devolve um **plano de corte** em .DXF, com as peças posicionadas na chapa respeitando a forma real de cada uma (*true shape*, não só a caixa envolvente), a física do corte (kerf, ponte entre peças, margem de borda), o sentido de fibra e a ordem segura de corte.

### 1.1 Princípios do produto

| Princípio | O que significa na prática |
|---|---|
| **Qualidade e precisão acima de velocidade** | O sistema nunca troca a correção do resultado por velocidade. O que o usuário controla é o *orçamento de busca* (quanto tempo/avaliações gastar), e não a correção do layout. |
| **Todo layout é auditado** | Antes de aparecer como aprovado, o layout passa por um **validador independente** (que não reutiliza o código do motor). Um layout reprovado **bloqueia a exportação**. |
| **Resultado reproduzível** | Mesma entrada + mesma semente = mesmo resultado. O botão de otimizar incrementa a semente para explorar alternativas. |
| **Honestidade nos números** | Os indicadores têm definição explícita (capítulo 8). Aproveitamento nunca conta o furo de uma peça como material aproveitado. |

### 1.2 Conceitos que aparecem o tempo todo

* **Peça mãe / peça filha (Part-in-Part).** Se uma peça tem um furo grande o bastante, o sistema pode cortar *outra peça do lote dentro desse furo*. A de fora é a "mãe"; a de dentro é a "filha" (verde na tela). A filha **não gasta chapa nova**.
* **Contorno externo e furos.** Externo = anti-horário (CCW). Furo = horário (CW). O sistema corrige a orientação sozinho.
* **Kerf (K).** Largura da fenda que o feixe/ferramenta remove.
* **Ponte / clearance (C_pp).** Material sólido que deve sobrar entre duas peças após o corte.
* **Distância nominal entre peças (D_nom).** `D_nom = C_pp + K`. É a menor distância permitida entre os contornos nominais de duas peças.
* **Retalho útil.** Retângulo de sobra grande o bastante para voltar ao estoque (lados ≥ *Retalho Mín.*).
* **Sucata aberta / alma estreita.** Região vazia ampla (boa para furar com o laser) versus a faixa estreita entre duas peças (a "alma" do esqueleto).
* **Coordenadas.** O eixo Y da tela e do DXF exportado é **para cima**, igual ao CAD. A origem (0,0) é o canto inferior esquerdo da chapa.

---

## 2. Fluxo de trabalho em 8 passos

A coluna da esquerda tem os quatro passos numerados (**1 Peças, 2 Chapa, 3 Corte, 4 Busca**). Cada passo fechado mostra um resumo do que está escolhido; clique para abrir.

1. **Peças:** arraste o .DXF para a área tracejada (ou clique em **Abrir**, ou escolha um **Exemplo**) e **leia o diagnóstico** (3.4): o que foi lido, ignorado, corrigido ou detectado (moldura, chapa usada, cópias, unidade). Confira as quantidades: cópias idênticas no desenho já chegam somadas (ex.: 87 gomos desenhados = 1 peça × 87). Os atalhos *todas 1*, *×2*, *×5*, *×10* e *encher a chapa* ajudam.
2. **Chapa:** comprimento × largura, ou **Usar uma chapa desenhada (DXF)** quando o estoque for irregular (sobra, chapa com furo/defeito). Se a chapa usada vier desenhada **junto** com as peças, o diagnóstico oferece usá-la (3.2). Em **Estoque deste cálculo**, diga quantas chapas inteiras podem ser usadas e quais retalhos do estoque entram antes delas (3.5).
3. **Corte:** escolha o processo e a espessura e clique em **Preencher com valores de partida**. Ajuste só o que a sua máquina exigir.
4. **Busca:** o **Tempo de busca** — *Rascunho* para conferir a ideia, *Padrão* para o dia a dia, *Produção* para o layout que vai ser cortado.
5. **O cálculo começa sozinho** quando há peças e chapa, e recomeça sempre que você muda alguma coisa (o cálculo anterior é parado na hora, no servidor também). Acompanhe a barra acima da mesa. Pode comparar as alternativas (botões abaixo da mesa). Para encerrar antes do fim e ficar com o melhor layout até ali, use **Parar e manter o melhor** no alto da tela; **Calcular de novo** roda outra vez com outra semente.
6. **Confira** na coluna da direita (**Resultado**): validação **APROVADO**, peças alocadas = lote, retalhos, sequência de corte e perfurações na tela.
7. **Exporte o DXF** (**Baixar DXF de corte**) e importe no software da máquina. Faça um **corte de teste** na primeira vez de cada combinação material/espessura (capítulo 7).

---

## 3. Preparando os arquivos DXF

### 3.1 DXF das peças

O leitor (V5.3, "DXF Doctor") aceita o DXF como o CAD gera — inclusive desenhos de **nesting já prontos** com a
moldura da chapa e peças em blocos/matrizes — e diz no **Diagnóstico** tudo o que fez.

| O que o arquivo pode ter | O que o sistema faz |
|---|---|
| `LINE`, `ARC`, `CIRCLE`, `ELLIPSE`, `LWPOLYLINE`/`POLYLINE` (com *bulge*), `SPLINE` (por controle ou só pontos de ajuste) | Lê. Curvas viram segmentos com erro máximo = *Flecha de Curvas*. |
| **Blocos** (`INSERT`), blocos dentro de blocos, **matrizes** (ARRAY, MINSERT), blocos dinâmicos, espelhados (escala −1) ou girados | **Expande** com a posição, giro, escala e espelho exatos. Não precisa explodir. |
| Unidade do desenho (`$INSUNITS`: mm, cm, m, polegada, pé…) | **Converte para mm**. Sem unidade declarada: assume mm e **avisa** (alerta alto se o desenho for imperial). Dá para forçar a unidade nas *Opções de importação*. |
| Layers congeladas, desligadas, não plotáveis, `Defpoints` | **Ignoradas** (não aparecem no CAD, não são cortadas). Opção para incluir. |
| Linhas tracejadas/de centro (tipo de linha `CENTER`, `HIDDEN`, `DASHED`…) | Tratadas como **auxiliares** (não cortadas). Opção para incluir. |
| Textos, cotas, hachuras, pontos, viewports | Ignorados. Texto dentro de uma peça vira o **nome** da peça; texto dentro da moldura vira o **rótulo** da chapa. |
| Contornos feitos de várias linhas/arcos soltos | **Costurados** (pontas a até 0,25 mm são a mesma). |
| Aberturas pequenas (0,25 a 1 mm) | **Fechadas** e relatadas com a posição. Maiores: o contorno fica **aberto**, não vira peça, e o diagnóstico mostra onde. |
| Linhas ou peças **duplicadas** sobrepostas | Removidas (seriam cortadas duas vezes) e relatadas. |
| **Moldura** (retângulo da chapa desenhado em volta das peças) | Detectada (critério no anexo da ADR 001): **não** vira peça; a chapa é ajustada para as medidas dela (dá para desfazer ou "Tratar como peça"). Várias molduras = várias chapas: escolha de qual pegar as peças. |
| **Cópias idênticas** (mesma forma e furos, em qualquer giro) | Viram **1 peça × N**. Peças espelhadas ficam separadas (cortar o espelho exige virar a chapa) e são apontadas. |
| Contorno que cruza a si mesmo, contornos que se cruzam | **Alerta** com a posição. Corrija no CAD. |
| Elementos menores que **0,5 mm** (largura e altura) | Descartados como ruído e relatados. |
| DWG, DXF binário, PDF, imagem | **Recusados** com instrução (ex.: "exporte como DXF ASCII"). |
| `REGION`, `3DSOLID`, `BODY`, referência externa (XREF) | Não suportados: **alerta** pedindo `EXPLODE`/`BIND` no CAD. |
| Entidades no espaço de papel (layout) | Ignoradas: só o espaço do modelo é lido. |

> **Peças repetidas:** pode desenhar uma vez e usar a quantidade, ou desenhar todas as cópias — o sistema soma as
> cópias idênticas. A quantidade preenchida pode ser alterada.

### 3.2 DXF da chapa (opcional)

* **Contorno externo** da chapa + **furos/defeitos internos** como contornos fechados.
* Os furos internos viram **obstáculos**: nenhuma peça os toca (respeitando a margem).
* A largura e a altura passam a ser as do contorno; os campos X/Y são preenchidos automaticamente.
* Para voltar à chapa retangular: botão **Voltar para a chapa retangular**.
* **Chapa usada desenhada junto com as peças (V5.6).** Se o DXF das peças tem um contorno grande com recortes (a chapa já usada) e as peças a cortar nele, o diagnóstico mostra a faixa **"parece uma chapa já usada"** com as medidas e o número de recortes. **Usar como chapa** tira esse contorno da lista de peças e o transforma na chapa; **Desfazer** volta a tratá-lo como peça. O sistema só sugere quando o contorno é bem maior que as outras peças juntas, comporta todas elas e tem recortes com forma de peça ou medida de chapa comercial; a decisão é sua.
* Com o **otimizador sparrow** instalado, a chapa desenhada também é calculada por ele (V5.6). No Modelo 3 de teste (12 anéis numa chapa 3000 × 1200 com 5 recortes), ele usou 2.426 mm da chapa contra 2.662 mm do motor clássico, no mesmo tempo.

### 3.3 Checklist de qualidade do desenho (faça antes de enviar)

- [ ] Medi uma cota conhecida da peça no CAD para confirmar a escala (e conferi a unidade no Diagnóstico).
- [ ] Todos os contornos fecham (o CAD tem comando de verificação/`OVERKILL`/`JOIN`).
- [ ] Furos pequenos de verdade estão no arquivo (o sistema também corta os furos pequenos: eles **não são ignorados**).
- [ ] Linhas de construção estão em layer desligada/não plotável ou com tipo de linha tracejado.

### 3.4 Diagnóstico do DXF (aparece após o envio)

| Parte | Para que serve |
|---|---|
| Selo **lido / conferir alertas / não lido** | Resumo. "Não lido": nenhuma peça foi lida. |
| Linha do arquivo | Versão, **unidade usada** (e de onde veio), entidades por tipo, blocos inseridos e níveis, contornos → peças diferentes → cópias no desenho. |
| Faixa de **moldura** | Medidas e rótulo da chapa desenhada; botões **Voltar** (medidas anteriores), **Usar moldura como chapa** e **Tratar como peça**. |
| Faixa **"parece uma chapa já usada"** (V5.6) | Contorno com recortes que pode ser a chapa; botões **Usar como chapa** e **Desfazer** (3.2). |
| Lista de itens | Erro (vermelho), Alerta (laranja), Aviso, Nota, com as **coordenadas do desenho** de aberturas, linhas soltas e cruzamentos. |
| **Opções de leitura** | Unidade, moldura (detectar/peça), tolerância de costura, fechar aberturas até X mm, cópias → quantidade, incluir tracejadas, incluir layers ocultas e **lista de layers** (desmarque para excluir). Qualquer mudança reanalisa sem reenviar o arquivo. |

### 3.5 Estoque do cálculo: várias chapas e retalhos (V5.8)

No passo **2 Chapa**, o bloco **Estoque deste cálculo** diz ao Prumo com o que ele pode contar:

* **Chapas inteiras com estas medidas:** quantas chapas do tamanho informado acima podem ser usadas (padrão 1; com uma chapa desenhada, o padrão vira 0, porque a ideia é gastar a sobra).
* **Retalhos do estoque:** **adicionar retalho** cria uma linha com comprimento × largura e quantidade. O × tira a linha.

O cálculo vai **chapa a chapa**, nesta ordem: a chapa desenhada (se houver), os retalhos do menor para o maior e as chapas inteiras. Cada chapa recebe só as peças que ainda faltam; o que não couber passa para a próxima. Um retalho em que nenhuma peça que falta cabe é pulado sem calcular. Cada chapa leva o tempo do modo de busca (Rascunho 10 s, Padrão 30 s, Produção 2 min).

Quando uma chapa não comporta tudo o que falta, o Automático faz assim: o motor clássico escolhe quais peças vão nela (metade do tempo), o otimizador sparrow reencaixa essas peças mais apertadas e tenta pôr outras nos vãos e na ponta que sobrou; fica o plano que aproveitar mais aquela chapa (ADR 009).

O resultado aparece com **abas**, uma por chapa usada, acima da mesa (retalhos com a borda lilás, chapa desenhada com a borda laranja). A coluna da direita ganha o bloco **Conjunto de chapas**: aproveitamento do conjunto (área das peças ÷ área das chapas usadas), chapas e retalhos usados, peças cortadas e as que **faltaram** (se o estoque acabou). **Baixar DXF de corte** baixa a chapa da aba aberta; **Baixar DXF de todas as chapas** baixa um arquivo por chapa (`chapa1_retalho_600x400.dxf`, `chapa2_chapa_1200x800.dxf`…).

Pela API, o mesmo vem em `config.stock_full_sheets` e `config.stock_remnants` (`[{width, height, quantity, ref}]`, `ref` = o código do retalho no seu sistema, que volta na resposta).

---

## 4. Lendo a tela

A tela tem três colunas (V5.6): à esquerda, os **passos** (o que entra); no meio, a **mesa** (o layout sobre a chapa, com régua em mm nas bordas, e abaixo dela o catálogo das peças lidas); à direita, o **Resultado** (aproveitamento em destaque e os números que importam), **Exportar** e **Servidor**. No alto ficam o nome do arquivo, o resumo do trabalho e os botões **Calcular de novo** e **Parar e manter o melhor**. Em telas estreitas as colunas se empilham.

O painel **Servidor** se atualiza a cada 2 s enquanto a aba está aberta: uso do processador (total e por núcleo), memória, quantos cálculos estão rodando e na fila, e se o otimizador sparrow está instalado e rodando.

### 4.1 Legenda de cores

| Cor | Significado |
|---|---|
| Azul | Peça (contorno externo anti-horário). |
| Verde | Peça filha cortada dentro de um furo de outra peça (*Part-in-Part*). |
| Amarelo | Furo **útil** (grande o bastante para virar sub-chapa/miolo reaproveitável). Com uma peça dentro, fica o contorno amarelo e o fundo amarelo-claro em volta da peça verde (V5.7). |
| Cinza hachurado | Furo **sem aproveitamento** (pequeno; só é cortado e cai como sucata). Até a V5.6 era vermelho-claro, que se confundia com a entrada de corte. |
| Lilás tracejado, etiqueta **R1 L × A** | Retalho útil de estoque (a etiqueta só aparece se couber dentro do retalho; o mouse mostra as medidas sempre). |
| Laranja tracejado | Furo/recorte/defeito da chapa (obstáculo). |
| Ponto vermelho + traço | **Perfuração (pierce)** e **lead-in** (entrada de corte). Número = ordem de corte. |
| Linha amarela tracejada | Avanço rápido **G00** (cabeçote sem cortar). |
| Linha **laranja** tracejada | G00 que **passa por cima de peça já solta** (risco de tombamento). |

### 4.2 Interação

* **Roda do mouse** = zoom · **arrastar** = mover · botões **+**, **−** e **Chapa inteira** ao lado da mesa · as caixas *retalhos* e *ordem de corte* ligam e desligam essas camadas.
* **Passar o mouse** numa peça mostra nome, giro, dimensões, posição e **ordem de corte**; num retalho, as dimensões e a área.
* **Alternativas:** ao final, até 6 layouts. Clique para inspecionar. ✔ = aprovada na validação, ✖ = reprovada.
* Uma nova otimização **limpa** as alternativas anteriores. As alternativas exibidas sempre pertence à execução atual.

---

## 5. Referência completa dos parâmetros

Convenção: **[Padrão]** é o valor inicial da tela. "Aumenta/diminui" descreve o efeito típico.

### 5.1 Processo de corte e espessura

| Campo | O que faz |
|---|---|
| **Processo de corte** | Laser de fibra, Laser CO₂, Plasma, Oxicorte, Jato d'água, Router CNC. |
| **Espessura (mm)** | Base para calcular os valores iniciais. |
| **Preencher com valores de partida** | Preenche *Kerf, Clearance, Margem, Lead-in, Cratera, Folga Furo→Peça, Furo Mín.* e *Tipo de Lead-in* com um ponto de partida conservador (anexo 16). **Não** é dado de fabricante. |

> **Quando usar:** sempre que mudar de material/espessura/processo. **Depois**, ajuste pela tabela de corte da sua máquina e confirme com corte de teste.

### 5.2 Chapa

| Campo | Unidade | O que faz |
|---|---|---|
| **Largura Chapa X** / **Altura Chapa Y** | mm | Dimensões da chapa retangular. Ignorados (e preenchidos sozinhos) quando há DXF de chapa. |
| **Margem Chapa** [6,0] | mm | Folga entre qualquer peça e a borda/obstáculo da chapa. A distância efetiva é **Margem + Kerf/2**. Cobre garras, empenamento e borda oxidada. **Aumente** em chapa laminada a quente, chapa empenada ou quando há garras. **Diminua** só com chapa plana e bem referenciada. |

### 5.3 Física do corte (o coração da precisão)

| Campo | Unidade | O que faz |
|---|---|---|
| **Kerf Feixe K** [0,4] | mm | Largura da fenda. Entra em **D_nom = Clearance + K**. Laser de fibra ≈ 0,15–0,4 · jato d'água ≈ 0,8–1,2 · plasma ≈ 1,5–4 · oxicorte ≈ 1,5–3 · router = diâmetro da fresa. |
| **Clearance Peças** [5,6] | mm | **Ponte** de material que deve sobrar entre duas peças. **Aumente** para chapa grossa, peças que empenam ou esqueleto que precisa ficar rígido. **Diminua** (com cuidado) para ganhar aproveitamento em chapa fina. |

**Exemplo numérico.** Kerf 0,4 + Clearance 5,6 → **D_nom = 6,0 mm** entre os contornos de duas peças. Margem 6,0 + Kerf/2 (0,2) → peça a **6,2 mm** da borda.

> ⚠️ **O DXF exportado contém os contornos NOMINAIS** (sem compensar o kerf). Quem compensa a largura do feixe é a **máquina** (G41/G42 ou compensação do software de CAM). O sistema usa o kerf só para garantir o espaçamento.

### 5.4 CAM: perfuração e lead-in

| Campo | Unidade | O que faz |
|---|---|---|
| **Lead-in Corte** [2,5] | mm | Comprimento (reta) ou **raio** (arco) da trajetória de entrada. O furo da perfuração fica na sucata e o feixe chega à aresta já em movimento, sem deixar marca na peça. Regra prática: **≥ espessura** (mín. ≈ 1,5 mm no laser; ≥ 5 mm no plasma). **0** = perfura direto no contorno (não recomendado). |
| **Tipo de Lead-in** | — | **Arco tangente** (recomendado, melhor acabamento) · **Reta a 45°** · **Reta perpendicular**. Se o tipo escolhido não couber, o sistema tenta os outros e, depois, um comprimento 40% menor. |
| **Cratera Pierce** [1,0] | mm | Raio de dano da perfuração. O ponto de perfuração fica a ≥ **raio + Kerf/2 + 0,3 mm** de qualquer contorno de peça e as perfurações ficam a ≥ **2 × raio + 1 mm** entre si. **Aumente** em chapa grossa e em jato d'água com material frágil. |

### 5.5 Furos e Part-in-Part

| Campo | Unidade | O que faz |
|---|---|---|
| **Furo Mín. Útil** [10 no manual; 60 nos exemplos] | mm | Um furo só é "útil" (amarelo) se **largura e altura** da sua caixa forem ≥ este valor. Só furos úteis recebem peças filhas. Furos pequenos continuam sendo **cortados**, só não são aproveitados. |
| **Folga Furo→Peça** [2,0] | mm | Distância mínima entre a peça filha e a **parede do furo** da mãe. **Aumente** quando a filha precisar de espaço para o lead-in e a cratera (chapa grossa, plasma). **Diminua** com cuidado em chapa fina. |
| **Preencher Furos Internos (hole_filling)** | liga/desliga | Permite o Part-in-Part. O encaixe é verificado pela **forma real**: uma bucha 18×18 mm **não** entra num furo Ø25 mm (a diagonal, 25,5 mm, invadiria a parede), mesmo que a caixa pareça caber. **Limite atual: 1 peça filha por furo.** |

### 5.6 Retalhos

| Campo | Unidade | O que faz |
|---|---|---|
| **Retalho Mín.** [35 no manual; 100 nos exemplos] | mm | Menor **lado** que um retângulo de sobra precisa ter para ser sinalizado como retalho útil. **Os dois lados** precisam atender. Ajuste ao que o seu estoque realmente reaproveita. |
| **Destacar retalhos** | liga/desliga | Mostra (ou oculta) os retângulos roxos na tela. Não altera o cálculo. |

### 5.7 Geometria das curvas

| Campo | Unidade | O que faz |
|---|---|---|
| **Flecha Curvas** [0,03] | mm | Erro máximo entre a curva real e os segmentos retos usados no cálculo. Menor = mais fiel e mais vértices (cálculo mais pesado). 0,01–0,05 é a faixa de laser/plasma. É aplicada **a cada execução** sobre o DXF original. |

### 5.8 Rotação e fibra

| Campo | O que faz |
|---|---|
| **Permitir rotação automática** | Se desligado, as peças ficam em 0° (equivale a *Travado sem giro*). |
| **Restrição de Fibra** | **Ortogonal** (0/90/180/270) · **Fibra eixo X** (0/180) · **Fibra eixo Y** (90/270) · **Multi-ângulo 45°** · **Alta densidade 15°** (24 orientações) · **Travado** (0°). |

> **Peças dobradas depois:** a linha de dobra **não pode** ficar paralela à fibra de laminação. Use *Fibra X* ou *Y* conforme o sentido da laminação **na sua chapa**. A restrição vale também para **peças filhas** (o sistema só as gira por ângulos compatíveis com a fibra).
>
> **Mais ângulos = melhor encaixe, mais tempo.** Ortogonal é o padrão. 45° e 15° ajudam em peças inclinadas, mas só use quando a fibra permitir.

### 5.9 Otimização

| Campo | O que faz |
|---|---|
| **Função Objetivo** | **Maior % de aproveitamento** (mais sobra recuperável) · **Maior retalho único** (uma sobra grande e inteira, boa para guilhotina) · **Menor envelope** (peças compactas num canto). Em todos, primeiro conta **mais peças alocadas**. |
| **Motor** (V5.5) | **Automático** (padrão): usa o **otimizador sparrow** quando ele está instalado no servidor e o job cabe no que ele resolve (lote que cabe numa chapa; desde a V5.6 a chapa pode ser desenhada, com recortes e defeitos); senão, o **motor clássico**, e a barra de progresso diz por quê. **Otimizador sparrow** e **Clássico** forçam a escolha. O sparrow deixa as peças se sobreporem e vai separando e apertando contra o início da chapa: o layout fica mais denso e a sobra contínua no fim da chapa, maior. Nos dois, o layout só é entregue se o **validador independente** aprovar. |
| **Tempo de busca** | Motor clássico: **Rascunho** (3.000 avaliações, proxy rápido; só para conferir a ideia) · **Padrão** (15.000, avaliação precisa) · **Produção** (60.000, avaliação precisa) · **Manual** (usa o campo *Avaliações*). Otimizador sparrow: o modo vira **tempo** — 10 s, 30 s e 120 s (o *Limite (s)*, se preenchido, manda). Regra: **para o que vai ser cortado, use Produção.** |
| **Avaliações (clássico)** | Orçamento de busca no modo Manual. Mais avaliações = mais chance de achar layout melhor (com retorno decrescente). |
| **Limite (s)** | `0` = sem limite. Ao atingir, encerra **e mantém o melhor layout até ali** (exibe "limite de tempo atingido"). |
| **Parar e manter o melhor** (botão no alto da tela) | Encerra a busca **ao fim da avaliação em curso** e entrega o melhor layout já validado e exportável. Útil com peças curvas/complexas, em que cada avaliação pode levar de décimos de segundo a alguns segundos. |
| **Semente** (V5.7: campo no passo 4) | Ponto de partida da busca; **Calcular de novo** soma 1, e dá para digitar uma. No motor clássico, mesma semente + mesma entrada = mesmo resultado. No sparrow, com o orçamento por tempo, o resultado pode variar entre execuções e máquinas (sempre validado); para repetir um plano, ligue **Resultado reproduzível**. |
| **Resultado reproduzível** (V5.7) | O otimizador sparrow para por **número de passos** em vez de tempo e divide as threads sempre do mesmo jeito (2 buscas × 3 threads desde a V5.8; na V5.7, 2 × 2). Mesmo desenho, mesmos parâmetros e mesma semente dão o mesmo plano em qualquer servidor. Passos: Rascunho 180, Padrão 540, Produção 2.160. O tempo varia com a máquina (numa com menos de 6 threads, demora mais); se passar do teto (8 × o tempo do modo, ou o *Limite (s)*), o plano sai e a tela avisa que ele pode não se repetir. |
| **Buscas em paralelo** (V5.7, automático) | O sparrow usa as threads da máquina (divididas entre os cálculos que estão rodando) em várias buscas ao mesmo tempo, cada uma com a sua semente, e fica com a melhor. A barra de progresso mostra quantas foram. Servidor compartilhado: `PRUMO_THREADS_PER_JOB` fixa as threads por cálculo. |

### 5.10 Corte de Linha Comum (CLC) — desativado (V5.4)

Com CLC, a distância entre peças vira apenas o kerf. **Atenção:** nesta versão o sistema **apenas reduz o espaçamento**; ele **não funde** as arestas comuns em um único passe de corte. O DXF exportado ainda contém **os dois contornos**, e as peças podem se tocar também em **curvas**. Por isso, desde a V5.4 a opção fica **desativada** na tela e é ignorada pela API (`common_line_cutting` é sempre falso; o pedido fica registrado em `common_line_requested`). Volta quando houver CLC real com arestas fundidas (roteiro, capítulo 14).

### 5.11 Lote

| Controle | Efeito |
|---|---|
| **[−] [Qtd] [+]** | Quantidade de cada peça (0 a 500; lote total até 2.000 peças). |
| **Tudo 1x/2x/5x/10x** | Multiplica todas as quantidades. |
| **encher a chapa** | Estima quantos **conjuntos completos** cabem: `⌊ (área da chapa × 0,72) ÷ área de um conjunto ⌋` (entre 1 e 80). É uma **estimativa inicial**; depois ajuste olhando *peças alocadas*. |

---

## 6. Receitas por cenário

> Os valores são ponto de partida. A coluna "Por quê" é para o operador entender e poder adaptar.

### 6.1 Laser de fibra, chapa fina (1–3 mm), produção em série

| Campo | Sugestão | Por quê |
|---|---|---|
| Processo/espessura | Laser de fibra, 2 mm → *Preencher com valores de partida* | Parte de valores coerentes. |
| Kerf / Clearance | ≈ 0,15–0,2 / ≈ 2–3 mm | Fenda fina; ponte curta rende mais peças. |
| Lead-in / Tipo | 1,5–3 mm / Arco | Chapa fina esquenta menos; arco curto basta. |
| Modo | Produção | Em série, 1% a mais de aproveitamento paga o tempo de cálculo. |
| Rotação | Ortogonal ou 15° se a fibra permitir | Mais ângulos = melhor encaixe. |

### 6.2 Plasma, chapa grossa (15–25 mm)

| Campo | Sugestão | Por quê |
|---|---|---|
| Processo/espessura | Plasma, 20 mm | |
| Kerf | ≈ 2,5–3,5 mm | Plasma é largo. |
| Clearance | ≈ espessura (mín. 5 mm) | Calor e distorção: ponte maior mantém o esqueleto rígido. |
| Margem | ≥ 12–15 mm | Garras e borda irregular. |
| Lead-in | ≥ 10–15 mm, arco | O plasma exige entrada longa. |
| Cratera | 3–4 mm | Perfuração agressiva. |
| Folga Furo→Peça | ≥ 8–10 mm | A filha precisa de espaço para o lead-in no anel de sucata. |

### 6.3 Peças que serão dobradas (sentido de fibra)

1. Descubra o **sentido de laminação** da chapa (certificado/marcação) e alinhe com o eixo X ou Y da chapa cadastrada.
2. Escolha **Fibra eixo X** ou **Y** conforme a linha de dobra da peça (a dobra não pode ficar paralela à fibra).
3. Aumente as avaliações: com menos ângulos o encaixe fica mais difícil, e o modo Produção compensa.
4. Confira, no hover, o **Giro** das peças e filhas.

### 6.4 Peças com furos grandes (aproveitar miolos e Part-in-Part)

1. Mantenha **Preencher Furos Internos** ligado.
2. Ajuste **Furo Mín. Útil** ao menor furo que vale aproveitar (ex.: 60 mm).
3. Ajuste **Folga Furo→Peça** ao processo (capítulo 5.5). Se uma filha "deveria caber" e não coube, **diminua um pouco a folga** ou o *Lead-in*, mas **não abaixo do que a máquina suporta**.
4. Lembre: **uma** filha por furo nesta versão.

### 6.5 Chapa de estoque irregular (sobra com defeitos)

1. Desenhe a sobra em DXF: contorno externo + furos/defeitos como contornos fechados.
2. No passo **2 Chapa**, clique em **Usar uma chapa desenhada (DXF)** e escolha o arquivo. Se a sobra estiver desenhada no mesmo DXF das peças, use a faixa **"parece uma chapa já usada"** do diagnóstico (3.2).
3. Aumente a **Margem** perto de defeitos conhecidos (o sistema aplica a mesma margem a bordas e obstáculos).
4. No motor clássico, chapas desenhadas calculam **mais devagar** (a verificação de borda é mais pesada). Com o otimizador sparrow (V5.6), os recortes e defeitos entram como obstáculos fixos e o custo extra é pequeno. Use **Limite (s)** se precisar travar o tempo.

### 6.6 Lote grande de peças idênticas

* Use **encher a chapa** para uma primeira estimativa; depois ajuste.
* Cópias idênticas são tratadas com cuidado pelo otimizador (trocar duas cópias iguais não gera alternativa nova), então o modo Produção rende melhor que em lotes variados.

### 6.7 Foco em retalho (cortar na guilhotina depois)

* **Função Objetivo = Maior retalho único.**
* Mantenha **Retalho Mín.** igual ao menor retalho que o estoque aceita.
* Compare as alternativas: escolha a que deixa a **maior sobra inteira**, mesmo com % um pouco menor.

### 6.8 Foco em compactação (peças agrupadas num canto)

* **Função Objetivo = Menor envelope.** Útil para cortar só uma região da chapa ou liberar o resto para outro serviço.

### 6.9 Cotação rápida vs. layout de produção

| Situação | Modo |
|---|---|
| Cliente pediu estimativa de material | **Rascunho** (segundos) |
| Conferir se as peças cabem / ajustar lote | **Padrão** |
| Layout que **vai ser cortado** | **Produção** (+ *Limite (s)* se precisar de teto) |

### 6.10 Material caro (inox, alumínio, titânio)

* Modo **Produção**, rodar **mais de uma semente** (otimize 2–3 vezes) e comparar. A diferença de 1–2% de aproveitamento em material caro paga a espera.

---

## 7. Como obter máxima precisão

### 7.1 Calibração do kerf (uma vez por processo/espessura/bico)

1. Corte um quadrado de teste (ex.: 50 × 50 mm) **sem** compensação de kerf.
2. Meça com paquímetro: `Kerf ≈ 50 − medida` (por lado: metade).
3. Informe o kerf real no campo. **Não** use o valor de catálogo.

### 7.2 Corte de teste de ponte e lead-in

1. Gere um layout com 4–6 peças pequenas e **Produção**.
2. Corte e verifique: a **ponte** entre peças ficou íntegra? A superfície do **lead-in** deixou marca na peça? A **cratera** ficou longe da peça?
3. Se houve marca: **aumente o Lead-in** ou use **Arco**. Se a ponte rompeu/empenou: **aumente o Clearance**.

### 7.3 Checklist de precisão por trabalho

- [ ] Escala do DXF conferida (mm).
- [ ] Kerf **medido** na máquina.
- [ ] **Flecha 0,01–0,03 mm** (curvas finas).
- [ ] Modo **Produção** para o layout final.
- [ ] Validação **APROVADO** e peças alocadas = lote.
- [ ] Nenhum aviso laranja de "G00 sobre peça solta" crítico (ou ordem revisada).
- [ ] DXF exportado aberto no CAD: peças com o **mesmo formato** do desenho original (o sistema não espelha).
- [ ] Primeira peça cortada medida antes de liberar o lote.

### 7.4 O que **não** melhora a precisão (mitos)

* "Mais iterações sempre melhoram": há retorno decrescente. A **precisão dimensional** vem de kerf, flecha e ponte, não de avaliações.
* "Flecha menor corrige a máquina": só reduz o erro de aproximação da curva (≤ valor configurado); não corrige folga mecânica.

---

## 8. Indicadores (KPIs): o que cada número significa

| Indicador | Definição exata |
|---|---|
| **Aproveitamento líquido (chapa inteira)** | `Σ área líquida das peças ÷ área líquida da chapa`. **Área líquida** = contorno − furos. Furo **não** conta como material aproveitado. |
| **Aproveitamento na área consumida** (número grande) | `Σ área líquida das peças ÷ (área da chapa − retalhos úteis)`. Responde: "do material que eu **gastei** (o que não volta ao estoque), quanto virou peça?" |
| **Retalho útil / maior retalho útil** | Retângulos livres com os dois lados ≥ *Retalho Mín.* (o maior e o total). |
| **Peças alocadas** | Peças posicionadas ÷ peças do lote. Se menor que 100%, aparece o alerta de peças que não coube. |
| **D_nom** | `Clearance + Kerf` (ou só `Kerf` em CLC). |
| **Perfurações** | Número de pierces. Entre parênteses: quantas ficaram em **alma estreita** (preferimos sucata aberta) e quantas **sem espaço validado**. |
| **Percurso G00 / Corte** | Soma dos deslocamentos rápidos e do perímetro cortado (em metros). Base para estimar tempo e custo. |
| **Validação do layout** | APROVADO/REPROVADO pelo validador independente (cap. 9). |

### 8.1 Exemplo numérico (para explicar ao cliente)

Chapa 1200 × 800 = 960.000 mm². Seis peças, uma delas um quadro com furo de 46.800 mm².

* Área **líquida** das peças = 272.000 mm² (o furo **não** conta).
* Retalhos úteis recuperáveis = 640.500 mm².
* **Aproveitamento na área consumida** = 272.000 ÷ (960.000 − 640.500) = **85,1%**.
* **Aproveitamento líquido da chapa inteira** = 272.000 ÷ 960.000 = **28,3%** (a maior parte da chapa volta ao estoque como retalho).

> **Por que versões antigas mostravam ~99%?** Elas somavam como "usada" a área *bruta* do quadro (incluindo o furo) **e** a da peça filha cortada dentro dele; e contavam como retalho faixas finas abaixo do mínimo. Na medição por uma régua independente, os dois layouts eram equivalentes. **O layout não mudou; o número ficou honesto.**

### 8.2 Como interpretar na prática

* **% alto na área consumida + retalho grande** = excelente: pouco material gasto e sobra aproveitável.
* **% alto na área consumida, mas retalho zero** = a chapa está cheia. Normal em lote grande.
* **% baixo e retalho zero** = peças espalhadas. Tente *Menor envelope*, mais avaliações ou rotação por 15°/45° (se a fibra permitir).

---

## 9. Validação independente e CAM: pierce, lead-in e sequência

### 9.1 O que o validador confere

| Verificação | Erro típico na tela |
|---|---|
| Peças perdidas ou duplicadas | "sumiram (nem posicionadas nem listadas)" |
| **Sobreposição** entre peças | "se sobrepõem" |
| Folga mínima **D_nom** entre peças | "…mm (mín. X)" |
| Margem da chapa e obstáculos | "viola a margem" / "invade furo da chapa" |
| Peça filha **inteira dentro do furo**, com a **Folga Furo→Peça** | "não está inteira dentro do furo" |
| **Rotação permitida** (fibra), inclusive nas filhas | "viola a restrição de fibra" |
| **Perfuração sobre material de peça** | "cairia sobre material" |

Layout **REPROVADO** bloqueia a exportação. Isso é de propósito: é melhor parar o trabalho do que cortar uma chapa errada.

### 9.2 Como o sistema planeja o corte

1. **Toda perfuração é validada**: dentro da chapa (a ≥ min(3 mm, Margem/2) da borda), **em sucata** (nunca sobre material de peça), longe das demais peças e da própria aresta.
2. **Todo contorno é perfurado**: contornos externos, **furos** (a perfuração fica dentro do vazio do furo) e peças filhas.
3. **Sucata aberta primeiro.** O sistema prefere perfurar em região ampla (longe de outras peças, da borda e de retalhos úteis). Só usa a "alma estreita" entre peças se **não houver alternativa**, e conta isso no indicador.
4. **Ordem Inside-Out, peça a peça:**
   1. furos e contorno das peças **filhas** dentro de cada furo;
   2. o **furo** da peça mãe;
   3. por fim, o **contorno externo** da mãe.
   Por quê: a peça mãe não pode soltar do esqueleto antes de seus furos e sub-peças estarem cortados.
5. **Ordem das peças otimizada** (vizinho mais próximo + melhorias de rota) para reduzir o deslocamento G00, com **penalidade** para G00 que atravessa peça já solta.

### 9.3 O que significam os avisos

| Aviso | O que fazer |
|---|---|
| "**G00 passa sobre peça já cortada**" (linha laranja) | Em chapa fina/peça pequena, risco de a peça solta tombar e bater no cabeçote. Reduza com *Menor envelope*, outra semente, ou configure no CAM da máquina **elevar o cabeçote** nesses trechos / microjuntas. |
| "**Lead-in sem espaço livre validado**" | Não achou onde entrar com a geometria pedida. Diminua *Lead-in* ou *Cratera*, ou aumente *Clearance* / *Folga Furo→Peça* para abrir espaço. |
| Perfuração em **alma estreita** (contador) | Aceitável em poucos casos. Se muitos: aumente o Clearance ou escolha outra alternativa da elite. |

---

## 10. Exportação do DXF

### 10.1 O que o arquivo contém

* Formato **DXF ASCII R12 (AC1009)**, unidade mm, escala **1:1**, sem espelhamento. R12 é o dialeto aceito por praticamente qualquer CAD/CAM.
* Entidades escritas **na ordem de corte**.
* **Padrão: só a geometria de corte** (camadas `1_CORTE_PECAS`, `1_PECA_IN_HOLE`, `2_CORTE_FUROS`). Os itens de referência são **opcionais**, cada um na sua camada.

| Layer | Conteúdo | Padrão |
|---|---|---|
| `1_CORTE_PECAS` | Contorno externo das peças mãe. | sempre |
| `1_PECA_IN_HOLE` | Contorno das peças filhas (dentro de furos). | sempre |
| `2_CORTE_FUROS` | Furos das peças. | sempre |
| `0_CHAPA_LIMITE` / `0_CHAPA_FUROS_OBSTACULOS` | Contorno e furos/defeitos da chapa. | opcional |
| `3_RETALHOS_UTEIS` | Retângulos de sobra. | opcional |
| `4_CAM_LEAD_IN` | Linhas/arcos de entrada. | opcional |
| `5_TEXTO_PECAS` | Nome de cada peça (texto). | opcional |

> **Por que o padrão mudou (V5.4).** Outros sistemas que identificam peças num DXF por contenção (sem olhar camada)
> liam o contorno da chapa como **uma peça gigante com as peças como furos**, os retalhos como peças e os lead-ins como
> "contornos que não fecharam". Com o padrão "só corte", qualquer leitor separa as peças corretamente. Detalhes para
> integração: `docs/FORMATO_DXF_EXPORTADO.md`.

**Baixar .DXF dos retalhos:** arquivo separado com cada retalho útil como contorno fechado + texto de medidas, para
cadastrar as sobras no estoque. Retalhos respeitam a mesma folga D_nom das peças (podem ser recortados sem atingir peça).

### 10.2 O que o arquivo **não** contém (importante)

* **Compensação de kerf:** os contornos são **nominais**. A compensação é da máquina.
* **Lead-out, microjuntas, G-code:** não são gerados.
* **Arcos e círculos reais:** curvas saem como polilinhas (erro ≤ *Flecha*), não como `ARC`/`CIRCLE`.

### 10.3 Importando na máquina

1. Abra o DXF no software da máquina; confirme unidade **mm**.
2. Mapeie as layers: cortes por layer (furos antes de contornos, como já vem ordenado). Se o software corta tudo o que
   está no arquivo, **não** marque "contorno da chapa", "retalhos" nem "lead-in" na exportação.
3. Defina a compensação de kerf (lado direito/esquerdo conforme o seu CAM) e o tipo de entrada (pode exportar o `4_CAM_LEAD_IN` como referência).
4. **Confira a primeira peça** antes de liberar o lote.

---

## 11. Boas práticas de produção

* Rode **Produção** para o layout final; guarde a **semente** e os parâmetros no registro do trabalho.
* **Registre** material, espessura, kerf medido, ponte e margem usados: o mesmo trabalho deve ser reproduzível.
* Compare **2–3 alternativas** (retalho vs. aproveitamento vs. G00) antes de decidir.
* Nunca force a exportação de um layout reprovado: corrija o parâmetro e gere de novo.
* Reveja os parâmetros quando trocar **bico, gás, lote de chapa ou máquina**.

---

## 12. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| **"Peças excederam o IFP"** (não alocadas) | Chapa pequena, margem/clearance altos, fibra muito restritiva | Reduza o lote, aumente a chapa, relaxe a fibra, revise margem/ponte. |
| **Layout REPROVADO** | Ver a mensagem (sobreposição, folga, margem, filha, fibra, pierce) | Corrija o parâmetro citado e rode de novo. Se persistir, **guarde os arquivos e avise o suporte**: é caso para investigação. |
| **Peça filha não entra no furo** | Furo pequeno, folga alta, fibra restritiva | Confira *Furo Mín. Útil*, reduza *Folga Furo→Peça*, libere rotação. Lembre: forma real, não caixa. |
| **"Lead-in sem espaço validado"** | Chapa muito apertada | Reduza *Lead-in*/*Cratera* ou aumente a ponte. |
| **Aproveitamento baixo** | Peças espalhadas, poucas rotações | Modo Produção, mais ângulos (se a fibra permitir), *Menor envelope*, mais sementes. |
| **Nenhum retalho útil** | Chapa cheia ou *Retalho Mín.* alto | Normal em lote cheio. Reduza *Retalho Mín.* se o estoque aceitar. |
| **Cálculo lento** | Chapa DXF customizada, muitos vértices, muitas peças | Use *Limite (s)*, aumente a *Flecha* (ex.: 0,05), ou modo Rascunho para conferir. |
| **DXF das peças "não lido" / peças faltando** | Ver o **Diagnóstico**: contorno aberto (coordenadas listadas), layer congelada/desligada, linha tracejada, bloco não inserido, REGION/3DSOLID | Feche o contorno (ou aumente "fechar aberturas até"), marque a layer, ative "incluir tracejadas", insira o bloco ou use EXPLODE. |
| **Uma peça gigante com todas as outras como furos** | Moldura não reconhecida (ex.: peças simples e sem rótulo) | Coloque o retângulo numa layer `MOLDURA`/`CHAPA`, ou um texto de chapa dentro dele. Aviso "possível moldura" indica o caso. |
| **O sistema tratou como moldura algo que é peça** | Placa com muitos recortes grandes | *Opções de importação* → Moldura: **Tratar como peça** (ou botão na faixa roxa). |
| **Peças com tamanho errado** | Unidade do DXF ausente ou errada | Veja a unidade no Diagnóstico; force em *Opções de importação* → Unidade. |
| **Linhas de centro viraram contorno** | Linha de centro com tipo de linha contínuo | Use tipo de linha `CENTER`/tracejado, layer não plotável, ou desmarque a layer no Diagnóstico. |
| **"O arquivo é um DWG"** | Enviou o DWG nativo | Exporte como DXF (DXFOUT / Salvar como). |
| **Otimização muito lenta com peças curvas** | Muitas peças com centenas de vértices | Use *Limite (s)*, o botão **Parar e manter o melhor**, ou aumente a *Flecha* (0,05). |
| **DXF exportado não abre** | (versões antigas) | Use o pacote V5.1+ (escritor R12). Se ocorrer: guarde o arquivo e informe a versão. |
| **Peça saiu espelhada** | (V5.0) | Corrigido na V5.1+. |

---

## 13. Roteiro de implantação na empresa cliente

### 13.1 Antes da visita (levantamento)

Pergunte e registre:

- [ ] Processos usados (laser, plasma, oxi, jato…) e **faixa de espessuras**.
- [ ] Materiais (aço, inox, alumínio…) e **sentido de laminação** relevante.
- [ ] Máquina(s) e software de CAM/controlador; **pós-processador**; formato de entrada (DXF R12? versões?).
- [ ] Como a empresa trata **retalhos** (tamanho mínimo, guilhotina, estoque).
- [ ] Origem dos desenhos (CAD, versões) e se usam **blocos/layers**.
- [ ] Hoje: aproveitamento médio, tempo de programação, refugo (para medir ganho).
- [ ] Quantas pessoas vão usar e com que perfil.

### 13.2 Sessão de implantação (sugestão de roteiro de 4 horas)

| Bloco | Conteúdo | Entregável |
|---|---|---|
| 1. Conceitos (30 min) | Cap. 1: mãe/filha, kerf, ponte, D_nom, validador | Equipe entende o vocabulário. |
| 2. Configuração do processo (45 min) | Preencher com valores de partida; **calibrar kerf** (7.1) | Perfil por processo/espessura. |
| 3. Preparação de DXF (45 min) | Cap. 3 com **arquivos reais** do cliente | Lista de ajustes nos desenhos. |
| 4. Primeiro nesting (45 min) | Fluxo do cap. 2 com um **pedido real** | Layout aprovado pela equipe. |
| 5. Corte de teste (60 min) | 7.2 na máquina | Ponte/lead-in/cratera validados. |
| 6. KPIs e retalhos (15 min) | Cap. 8 | Como reportar ganho. |

### 13.3 Perfil de configuração a deixar pronto

Registre, por **processo × espessura**, uma planilha: kerf medido, ponte, margem, lead-in, tipo, cratera, folga furo→peça, furo mínimo, retalho mínimo, fibra, e a semente de referência de um trabalho tipo.

### 13.4 Critérios de aceite (go-live)

- [ ] 3 trabalhos reais gerados, todos **APROVADO**.
- [ ] 1 trabalho **cortado** e medido (tolerância dimensional dentro do exigido pelo cliente).
- [ ] DXF abre sem erro no software da máquina.
- [ ] Operador consegue, sozinho: carregar DXF, escolher perfil, otimizar, conferir validação e exportar.
- [ ] Equipe sabe **quando parar** (layout reprovado / aviso crítico) e **a quem escalar**.

### 13.5 Pós-implantação (primeiros 30 dias)

* Revisão semanal dos aproveitamentos e retalhos.
* Registrar **todo** caso de layout reprovado ou resultado estranho (guardar DXF, parâmetros, semente, versão).
* Reunir pedidos de recurso (blocos `INSERT`, multi-chapa, G-code…).

---

## 14. Limitações conhecidas

Seja franco com o cliente sobre isto:

| Limitação | Impacto | Previsão |
|---|---|---|
| Várias chapas são calculadas **uma de cada vez** (V5.8) | A escolha das peças de cada chapa não olha as chapas seguintes; em casos raros, trocar peças entre chapas daria uma chapa a menos. | Otimização do conjunto (plano, fase 3). |
| **Uma peça filha por furo** | Furo grande pode receber mais peças, mas hoje recebe uma. | Evolução. |
| **CLC não funde arestas** | Não use em produção. | Evolução. |
| Entrada DXF: sem DXF binário, `REGION`/`3DSOLID`, XREF, hachura como contorno | Relatado no Diagnóstico; exige EXPLODE/BIND/ASCII no CAD. | Evolução. |
| Detecção de moldura é heurística (critério documentado) | Casos ambíguos geram aviso; o usuário decide. | — |
| DXF de saída: curvas em polilinhas, sem compensação de kerf, sem lead-out/microjunta/G-code | Depende do CAM da máquina. | Evolução. |
| Motor clássico posiciona por candidatos heurísticos | Pode perder encaixes sutis em formas côncavas. O **otimizador sparrow** resolve isso em chapa retangular (V5.5) e em chapa desenhada (V5.6). | Várias chapas no otimizador novo (plano, fase 3). |
| Otimizador sparrow precisa ser **compilado** no servidor (`npm run build:sparrow`, Rust) | Sem ele, o Automático usa o clássico e avisa. | — |
| Chapa DXF customizada e peças com muitos vértices: cálculo mais lento no motor clássico | Use *Limite (s)* ou **Parar e manter o melhor**. | Posicionamento por NFP exato (fase 2.1). |
| Valores iniciais por processo **não são dado de fabricante** | Exigem calibração. | — |

---

## 15. Glossário

| Termo | Significado |
|---|---|
| **Nesting** | Arranjo de peças na chapa para minimizar desperdício. |
| **True shape** | Usa a forma real da peça, não a caixa que a envolve. |
| **Kerf** | Largura da fenda de corte. |
| **Ponte / web** | Material que sobra entre duas peças. |
| **D_nom** | Ponte + kerf: distância nominal mínima entre peças. |
| **Part-in-Part / hole filling** | Cortar peças menores dentro de furos de peças maiores. |
| **Lead-in** | Trajetória de entrada do corte a partir do ponto de perfuração. |
| **Pierce** | Perfuração inicial (furo de entrada). |
| **Cratera** | Região danificada ao redor do pierce. |
| **Inside-Out** | Cortar do interior para o exterior (furos antes do contorno). |
| **G00** | Deslocamento rápido (sem cortar). |
| **CLC** | Corte de linha comum (uma passada separa duas peças). |
| **Fibra / grain** | Sentido de laminação do metal. |
| **Retalho** | Sobra reaproveitável. |
| **Elite** | Melhores soluções encontradas na otimização. |
| **IFP / NFP** | Inner-Fit / No-Fit Polygon: regiões geométricas de posicionamento válido/inválido. |
| **Validador** | Verificação independente do layout final. |

---

## 16. Anexo: valores iniciais por processo

Calculados por **processo + espessura (t)**. São **pontos de partida conservadores**, não dados de fabricante. Calibre na máquina (capítulo 7).

| Processo | Kerf (mm) | Ponte (mm) | Margem (mm) | Lead-in (mm) | Cratera (mm) | Furo mín. (mm) |
|---|---|---|---|---|---|---|
| Laser de fibra | 0,12 + 0,012·t (0,15–0,45) | máx(1,5; t) | 5 + 0,3·t (5–12) | máx(1,5; t) (≤ 8) | 0,5 + 0,3·t (0,8–4) | máx(15; 4·t) |
| Laser CO₂ | 0,2 + 0,015·t (0,2–0,6) | máx(2; t) | 6 + 0,3·t (6–14) | máx(2; t) (≤ 10) | 0,8 + 0,3·t (1–5) | máx(15; 4·t) |
| Plasma | 1,2 + 0,08·t (1,5–4) | máx(5; t) | 8 + 0,3·t (10–20) | máx(5; t) (≤ 15) | 1,5 + 0,1·t (2–5) | máx(30; 3·t) |
| Oxicorte | 1,5 + 0,04·t (1,5–3) | máx(10; 0,5·t) | 10 + 0,2·t (15–30) | máx(8; 0,5·t) (≤ 25) | 2 + 0,05·t (3–8) | máx(40; 3·t) |
| Jato d'água | 0,8 + 0,005·t (0,8–1,2) | máx(3; 0,25·t) | 8 + 0,1·t (8–15) | máx(3; 0,3·t) (≤ 12) | 1,5 + 0,05·t (1,5–4) | máx(15; 3·t) |
| Router CNC | = diâmetro da fresa | máx(4; D) | máx(10; 2·D) | máx(D; 6) | D/2 | máx(2·D; 15) |

* **Folga Furo→Peça** = `máx(2; kerf + 0,5·lead-in + 1)` em todos.
* **Tipo de lead-in** inicial: arco tangente.
* Exemplo: **Laser de fibra, 3 mm** → kerf 0,16 · ponte 3 · margem 5,9 · lead-in 3 · cratera 1,4 · furo mín. 15 · folga furo→peça 2,7.

---

*Fim do manual. Sugestões de melhoria deste documento: registre no pós-implantação e envie à equipe de desenvolvimento.*
