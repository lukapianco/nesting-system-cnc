# ADR 001 — Leitor DXF próprio e "DXF Doctor"

**Status:** aceito (V5.3) · **Fase do plano:** 1.2 (DXF Doctor) e 0.4 (unidades)

## Contexto

Dois DXF reais enviados pelo usuário (`test/fixtures/Modelo_1_c_moldura.dxf` e `Modelo_2_c_moldura.dxf`,
AutoCAD 2018, `AC1032`) "davam erro no motor". O que foi medido no V5.2:

| Arquivo | O que o desenho tem | O que o V5.2 lia |
|---|---|---|
| Modelo 1 | moldura 2000×1200 + 22 peças em **matrizes associativas** (INSERT → bloco anônimo `*U` → INSERT → bloco nomeado; até 3 níveis, giros de 90/180/270°) | **1 contorno**: só a moldura, tratada como peça |
| Modelo 2 | moldura 3000×1200 (2 polilinhas **abertas**) + 87 "gomos" (SPLINE + LINE) em matriz | **0 contornos** |

Causa: o `cadParser` lia só `dxf.entities` do pacote `dxf-parser` e **ignorava INSERT** (blocos), ELLIPSE,
layers e `$INSUNITS`. Além disso, um retângulo desenhado em volta das peças (a "moldura", que no Modelo 2 é a chapa
de 3×1,2 m citada no texto `AISI 304 #1/8" 3x1,2m - 87 Gomos`) virava uma peça gigante com todas as outras como furos.

## Opções

1. **Continuar com `dxf-parser` e expandir INSERT em cima dele.** Ele entrega os blocos, mas: não aplica OCS
   (extrusão), não diferencia espaço de papel de forma confiável, não trata código de página/escapes, é escrito em
   TypeScript sem build CommonJS no repositório (só no npm) e a manutenção é externa.
2. **Leitor próprio de pares código/valor** (DXF ASCII é um formato simples e bem documentado) e um pipeline de
   saneamento ("DXF Doctor") com relatório.
3. Converter via ezdxf (Python) num processo auxiliar. Exige Python no servidor do cliente; descartado.

## Decisão

Opção 2. Pasta `dxf/`, sem dependências:

| Módulo | Papel |
|---|---|
| `dxf/reader.js` | bytes → documento: detecta DWG/DXF binário/PDF/ZIP (erro claro), UTF-8 ou code page do `$DWGCODEPAGE`, escapes `\U+XXXX`, vírgula decimal, arquivos sem EOF ou com quebras CR; HEADER, LAYER, LTYPE, BLOCK_RECORD, BLOCKS, ENTITIES; ignora XDATA e grupos `{...}`; separa espaço de papel. |
| `dxf/flatten.js` | documento → caminhos **exatos** no plano XY em mm: INSERT aninhado (pilha de transformações 3D: OCS · T(pos) · R · T(célula MINSERT) · S · T(−base)), espelhamento, MINSERT, OCS ("Arbitrary Axis Algorithm"), ELLIPSE, SPLINE (controle ou ajuste), LWPOLYLINE/POLYLINE com bulge, POLYLINE 3D; malhas ignoradas; herança de layer "0" e BYBLOCK; proteção contra bloco recursivo e explosão de tamanho. |
| `dxf/curves.js` | discretização com **flecha garantida** (arco/elipse afim pelo semieixo maior; NURBS por vão de nós com teste em ¼, ½, ¾; SPLINE só de ajuste por interpolação cúbica global). |
| `dxf/heal.js` | costura por **grafo de extremidades** (não segmento a segmento), duplicatas, fechamento de aberturas entre pontas mutuamente mais próximas até `maxGapHeal`, anéis degenerados, auto-interseção. |
| `dxf/doctor.js` | política de layers (congelada/desligada/não plotável/Defpoints/tracejada), árvore de contenção robusta, **detecção de moldura**, rótulos de texto, cruzamento entre contornos, escala suspeita, blocos não usados, **relatório**. |
| `geometry/congruence.js` | cópias idênticas (a menos de translação e rotação, verificado por Hausdorff) → **1 peça × N**. Espelho é apontado mas não agrupado. |

O `dxf-parser` ficou só como **devDependency**, usado nos testes para ler o DXF que **nós** exportamos (verificação
independente do escritor).

### Regra da moldura (critério explícito)

Um anel de nível 0 é moldura quando é um **retângulo alinhado aos eixos**, contém contornos, **não** vem do mesmo
bloco que eles, e há pelo menos um destes sinais:
layer com nome de chapa (`MOLDURA`, `CHAPA`, `SHEET`, `BORDER`…); texto de chapa/material dentro dele;
contornos internos com furos próprios (são peças, não furos); ou contornos internos que ocupam ≥ 25% do retângulo
**e** são majoritariamente "forma de peça" (não círculo/retângulo/oblongo/elipse/polígono convexo de poucos lados)
ou vêm de blocos/matrizes. Só círculos dentro = chapa perfurada, exceto com sinal forte (arruelas com furo, rótulo).
Casos ambíguos geram o aviso `POSSIBLE_FRAME` e a peça é mantida. O usuário pode sempre escolher "Tratar como peça".

Verificado: os dois modelos reais são molduras; o preset `industrial` (placa 450×320 com recorte e 2 furos, 20% de
vazio) **não** é. Este falso positivo apareceu num primeiro critério (só ocupação ≥ 15%) e foi corrigido antes da entrega.

## Dados medidos

| Arquivo | Leitura + catálogo | Resultado |
|---|---|---|
| Modelo 1 | ~0,1 s | moldura 2000×1200; 22 peças = `sd`×8, `b`×8, `xscd`×6 (`xsx` e `xscd` são a mesma peça em blocos diferentes: agrupadas por geometria); 1 marca de canto de 10 mm relatada |
| Modelo 2 | ~0,7 s | moldura 3000×1200; 87 gomos = 1 peça × 87; 34 blocos não usados relatados (inclusive o que traz o rótulo "87 Gomos" e o da chapa de flanges, que **não está inserida** no desenho) |

## Consequências

* Upload devolve `report` (itens com severidade erro/alto/medio/baixo/info e posições), `frames` e `suggestedSheet`.
* `POST /api/reanalyze-dxf` reaplica opções (layers, unidade, moldura, costura) sem reenviar o arquivo.
* Erros de leitura viram **HTTP 422** com mensagem para o operador (antes: 500 genérico).
* Ainda não suportado (relatado quando aparece): DXF binário, REGION/3DSOLID/BODY (precisa EXPLODE no CAD), XREF não
  vinculada, HATCH como contorno, textos como geometria de gravação.
