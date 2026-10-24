# Prumo — motor de nesting 2D

O Prumo recebe peças desenhadas em DXF, encaixa as peças na chapa pelo **contorno real** (*true shape*) e devolve:

- o plano de corte;
- os retalhos que sobram;
- a ordem de corte com entradas de corte (lead-in);
- um DXF pronto para o CAM da máquina.

Serve para laser, plasma, oxicorte, jato d'água e router.

O escopo é **só o nesting**. Estoque de chapas, ordens de serviço e rastreio de sobras ficam no sistema de gestão, que conversa com o Prumo pela API.

> Versão atual: **5.7** — veja o [CHANGELOG](CHANGELOG.md).
> Manual de operação: [`docs/Manual_Prumo.md`](docs/Manual_Prumo.md).
> Decisões técnicas: [`docs/adr/`](docs/adr).

## O que ele faz

| Área | O que o Prumo entrega |
|---|---|
| **Leitura de DXF** ("DXF Doctor") | Lê blocos aninhados e matrizes, elipses, splines, polilinhas com arco, unidades (`$INSUNITS`) e camadas auxiliares (cota, texto, eixo…). Costura linhas soltas e fecha aberturas pequenas, sempre avisando onde. Detecta a moldura (a chapa desenhada em volta das peças) e a chapa já usada desenhada junto com as peças (contorno grande com recortes), e transforma cópias idênticas em quantidade. Cada problema vem num relatório com a coordenada. |
| **Encaixe** | Dois motores. O **otimizador sparrow** (padrão quando instalado) minimiza a sobreposição e comprime as peças contra uma ponta da chapa. Desde a V5.6 ele também trabalha em chapa desenhada (irregular, com recortes e defeitos). O **motor clássico** (BRKGA + BLF) atende lote maior que a chapa e serve de reserva. Os dois giram as peças conforme a restrição de fibra. O Part-in-Part (peça dentro do furo de outra) vale nos dois. |
| **Validação independente** | Todo layout passa por um validador que não usa código do motor. Ele confere sobreposição, folga entre peças, margem e furos da chapa, filhas dentro do furo, retalhos, ângulo de fibra e perfuração em sucata. Layout reprovado não é exportado. |
| **Retalhos** | Retângulos úteis na sobra, com a mesma folga das peças, para ir para o estoque. |
| **CAM** | Ordem de corte de dentro para fora, lead-in em arco ou reta, perfuração conferida em sucata e deslocamentos G00. |
| **Exportação** | DXF R12 em mm. Por padrão leva **só a geometria de corte**, porque outros sistemas leem esse arquivo; chapa, retalhos, lead-ins e nomes são opcionais. O formato está em [`docs/FORMATO_DXF_EXPORTADO.md`](docs/FORMATO_DXF_EXPORTADO.md). |

## Como instalar

### Requisitos

- **Node.js 18 ou mais novo.**
- **Rust 1.90 ou mais novo** — só para compilar o otimizador sparrow (recomendado).

### Passos

```bash
npm install
npm run build:sparrow     # opcional e recomendado: compila native/prumo-sparrow (uns 2 min na 1ª vez)
npm start                 # http://localhost:3000
```

### Sem o Rust

O Prumo funciona igual com o motor clássico, e a tela avisa que o sparrow não está instalado.

Se o executável estiver em outro lugar, aponte com a variável de ambiente `PRUMO_SPARROW_BIN`.

## Como usar (bancada de testes)

A tela tem três colunas: os passos à esquerda, a mesa (o layout na chapa, com régua em mm) no meio e o resultado à direita.

1. **Peças:** arraste o `.dxf` para a tela ou abra um dos exemplos. O diagnóstico mostra o que foi lido, o que foi ignorado e por quê.
2. **Chapa:** informe comprimento × largura, ou use uma chapa desenhada em DXF. Se o desenho tiver moldura, a chapa já vem ajustada; se tiver uma chapa usada desenhada junto, a tela oferece usá-la.
3. **Corte:** processo e espessura (sugerem kerf e folgas), margem, giro das peças.
4. **Busca:** tempo de busca e motor (Automático, sparrow ou clássico).

O cálculo começa sozinho e recomeça quando a entrada muda (o anterior é parado no servidor). **Parar e manter o melhor** encerra quando quiser. À direita ficam o aproveitamento, a validação, os botões **Baixar DXF de corte** e **Baixar DXF dos retalhos** e o uso do servidor, atualizado a cada 2 s.

## API

| Método | Rota | Para quê |
|---|---|---|
| `GET` | `/api/hardware` | CPU, workers, fila, uso medido (`usage`: CPU total e por núcleo, memória, cálculos rodando) e se o otimizador sparrow está instalado e rodando |
| `POST` | `/api/upload-dxf` | Lê o DXF de peças (`multipart`, campo `dxfFile`) e devolve peças, furos, cópias, molduras, candidatos a chapa usada (`sheetCandidates`) e diagnóstico |
| `POST` | `/api/reanalyze-dxf` | Relê o último arquivo com outras opções de importação (camadas, moldura, unidade, `sheetContour` para usar um contorno como chapa) |
| `POST` | `/api/upload-sheet-dxf` | Lê o DXF de uma chapa irregular (com furos/defeitos) |
| `POST` | `/api/start-job` | Cria o job (`uploadId`, `config`, `quantities`) e devolve o `jobId` |
| `GET` | `/api/stream/:jobId` | Progresso em tempo real (SSE): `queued`, `progress`, `done`, `error`. Fechar a conexão cancela o job e o processo do otimizador |
| `POST` | `/api/stop/:jobId` | Para e entrega o melhor layout já validado |
| `GET` | `/api/process-profiles`, `/api/recommend-params` | Perfis de processo e parâmetros sugeridos |
| `POST` | `/api/export-dxf` | DXF de corte (opções de camadas no corpo) |
| `POST` | `/api/export-remnants-dxf` | DXF só dos retalhos |
| `GET` | `/api/sample-dxf?preset=` | DXF de exemplo (`icamento`, `trueshape`, `industrial`, chapas `sheet_*`) |

Erros de arquivo respondem **422**, com a mensagem em português. A especificação completa, com exemplos e regras para quem integra, está no plano (fase 4).

## Testes e benchmark

```bash
npm test                  # regressão, DXF Doctor, unidades do motor, otimizador sparrow (se compilado)
npm run test:ui           # interface real no Chromium (precisa do Playwright)
bash bench/public/fetch-instances.sh                         # baixa as 13 instâncias públicas (ESICUP)
node bench/public/run.js --time 60 --seeds 5                 # motor clássico
node bench/public/run.js --engine sparrow --time 60 --seeds 5
node bench/paralelo.js                                        # como dividir as threads da sua máquina (ADR 008)
```

O benchmark mede a densidade e a validade **fora do motor**: polígonos posicionados, validador independente e contagem de peças. As tabelas estão no CHANGELOG e em `bench/public/results/`. O protocolo está nas ADRs 005 e 006.

## Estrutura

```text
index.js              servidor HTTP, fila de workers, SSE, exportação
nestingWorker.js      orquestra o encaixe de um job (motor clássico + ponte para o sparrow)
engine/               colisão exata indexada; ponte para o otimizador externo
native/prumo-sparrow/ otimizador sparrow + jagua-rs (Rust, código completo; ver PRUMO_MODIFICACOES.md)
dxf/                  DXF Doctor (leitor, curvas, diagnóstico)
geometry/             primitivas geométricas compartilhadas
cadParser.js          contornos → peças e furos; cópias → quantidade
validator.js          validador independente
camPlanner.js         ordem de corte, lead-in, perfuração
dxfWriter.js          exportação DXF
public/               bancada de testes (HTML + JS, sem build)
test/, bench/         testes e benchmarks
docs/                 manual, ADRs, diário de bordo, formato do DXF exportado
```

## Licenças

Os componentes de terceiros e suas obrigações estão em [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md):

- **sparrow:** MIT;
- **jagua-rs:** MPL-2.0;
- **Clipper2:** Boost.

As instâncias ESICUP do benchmark são baixadas pelo script e não fazem parte do repositório.
