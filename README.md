# ⚙️ DXF Nesting Industrial True-Shape (CAD/CAM Engine V5)

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-Backend%20SSE-000000?style=for-the-badge&logo=express&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-Wasm%20Optional-DEA584?style=for-the-badge&logo=rust&logoColor=black)
![HTML5 Canvas](https://img.shields.io/badge/HTML5-Canvas%202D-E34F26?style=for-the-badge&logo=html5&logoColor=white)

Sistema web de **Nesting 2D Industrial (CAD/CAM)** para otimização de planos de corte em chapas metálicas (Laser, Plasma, Oxicorte e Jato d'Água) a partir de arquivos vetoriais `.DXF`[cite: 5, 14].

O motor realiza o processamento geométrico pesado 100% no **Backend via `worker_threads`** (alcançando de **25.000 a 65.000+ simulações por segundo**), transmite o progresso em tempo real via **SSE (Server-Sent Events)**, aproveita furos internos para alocar peças menores (**Nesting In-Hole**), mapeia retalhos padronizados para estoque e exporta o arquivo `.DXF` final pronto para a máquina CNC[cite: 14, 15].

---

## 🎯 Principais Funcionalidades

* **Processamento Multi-Thread no Servidor (`worker_threads` + Fila FIFO):** O navegador atua apenas como terminal visual leve (zero cálculo pesado no cliente)[cite: 14, 16]. O servidor gerencia um pool de threads limitado a `N - 1` núcleos da VPS para suportar múltiplos usuários simultâneos sem travar o Event Loop[cite: 16].
* **Leitura e Costura Automática de `.DXF`:** Interpreta entidades `LWPOLYLINE`, `POLYLINE`, `CIRCLE` e costura linhas soltas (`LINE`) conectadas pelas extremidades, convertendo-as em polígonos fechados[cite: 5, 16].
* **Suporte a Chapa Principal por Medidas ou via `.DXF` Customizado:** Permite definir chapas retangulares (`Largura X` / `Altura Y`) ou enviar o desenho `.DXF` de uma chapa irregular/recortada (ex.: chapa em formato de "L" ou degrau)[cite: 14, 15].
* **Nesting In-Hole Sincronizado (Sem Duplicação de Furos):** Furos internos grandes nunca são duplicados fora da peça[cite: 14]. Eles atuam como "sub-chapas gratuitas" onde peças menores do próprio pedido são encaixadas (girando 90° sincronizadamente com a peça mãe) ou são contabilizados como buchas/miolos gerados a custo zero[cite: 14, 17].
* **Colisão Poligonal True-Shape:** Permite encaixar peças dentro de recortes côncavos (peças em "L", chanfros e diagonais) combinando decomposição de caixas sólidas, interseção de segmentos e distância mínima ponto-aresta[cite: 14, 17].
* **Extração de Retalhos Padronizados (Sobras Úteis):** Subdivide a área livre restante da chapa em retângulos e quadrados disjuntos (sem sobreposição) para reaproveitamento futuro no estoque[cite: 8, 14].
* **Corte Comum (*Common-Line Cutting*):** Opção para colapsar o espaçamento (`Kerf`) para a espessura do feixe de laser (`0.4 mm`) onde duas paredes retas paralelas se encontram[cite: 9, 15].
* **Exportação `.DXF` Multi-Layer (Escala 1:1 mm):** Gera o arquivo `.DXF` final separado em camadas (`0_CHAPA_LIMITE`, `1_CORTE_PECAS`, `1_PECA_IN_HOLE`, `2_CORTE_FUROS` e opcionalmente `3_RETALHOS_UTEIS`)[cite: 9, 15].

---

## 📂 Estrutura do Projeto

```text
dxf-nesting-app/
├── package.json              # Dependências do projeto (express, multer, dxf-parser)
├── server.js                 # API Gateway, Parser DXF, Fila de Workers e Stream SSE
├── nestingWorker.js          # Motor Matemático em Worker Thread (In-Hole, True-Shape, Retalhos)
├── rust-engine/              # (Opcional) Acelerador geométrico em Rust p/ WebAssembly
│   ├── Cargo.toml            # Manifesto Rust e configuração wasm-bindgen
│   └── src/lib.rs            # Rotinas de ponto-em-polígono em Rust
└── public/
    ├── index.html            # Interface CAD/CAM Neo-Brutalista
    ├── style.css             # Estilização visual e layout
    └── app.js                # Cliente SSE, Renderizador Canvas 2D e Exportador DXF
```

---

## 🚀 Como Instalar e Executar

### Pré-requisitos
* **Node.js** v18 LTS ou superior[cite: 14].
* *(Opcional)* **Rust + `wasm-pack`** caso deseje compilar o módulo complementar `rust-engine`[cite: 14].

### Passo a Passo

1. Clone o repositório e instale as dependências[cite: 14]:
   ```bash
   git clone [https://github.com/seu-usuario/dxf-nesting-app.git](https://github.com/seu-usuario/dxf-nesting-app.git)
   cd dxf-nesting-app
   npm install express multer dxf-parser
   ```

2. *(Opcional)* Para compilar o acelerador em Rust para WebAssembly[cite: 15]:
   ```bash
   cd rust-engine
   wasm-pack build --target nodejs
   cd ..
   ```
   > **Nota:** Se você não compilar a pasta `rust-engine`, o `nestingWorker.js` detecta automaticamente e executa 100% dos cálculos no motor V8 nativo do Node.js sem qualquer perda de funcionalidade[cite: 15].

3. Inicie o servidor[cite: 15]:
   ```bash
   node server.js
   ```

4. Acesse no navegador[cite: 15]:
   ```text
   http://localhost:3000
   ```

---

## 🖥️ Como Usar a Aplicação

1. **Carregar as Peças de Corte (`.DXF`):**
   * No painel lateral **1. Arquivos .DXF**, clique no primeiro campo para enviar seu arquivo `.dxf` ou escolha um dos **3 exemplos industriais prontos** na barra superior e clique em **Carregar Peças**[cite: 15].
2. **Definir a Chapa Principal:**
   * **Modo Retangular:** Informe a **Largura Chapa X (mm)** e **Altura Chapa Y (mm)** no painel lateral[cite: 15].
   * **Modo Chapa Desenhada (`.DXF`):** Envie um arquivo `.dxf` com o formato exato do retalho/chapa disponível no segundo campo (roxo) ou clique em **Testar Chapa Desenhada (Formato L/Degrau)** no topo[cite: 15].
3. **Configurar Parâmetros de Engenharia:**
   * **Distância / Kerf (mm):** Espaçamento mínimo de segurança entre peças (largura do feixe + ponte térmica)[cite: 6, 15].
   * **Furo Mín. Útil (mm):** Menor dimensão (`Largura` e `Altura`) para que um furo interno possa receber peças menores lá dentro (*Nesting In-Hole*) ou ter seu miolo contabilizado como aproveitável[cite: 15].
   * **Retalho Mín. Chapa (mm):** Menor medida lateral para demarcar sobras retangulares/quadradas na chapa[cite: 15].
   * **Nº de Cálculos (Worker):** Quantidade de iterações executadas na thread do servidor (ex.: `20000` a `100000`)[cite: 15].
   * **Critério do Juiz:** Escolha se o otimizador deve priorizar **Maior % de Aproveitamento**, **Maior Retalho Único Inteiro** ou **Menor Caixa Ocupada**.
4. **Inspecionar e Exportar:**
   * Acompanhe a barra de progresso em tempo real e alterne entre os **6 melhores layouts distintos** nos botões abaixo do canvas[cite: 16].
   * Na seção **3. Exportar .DXF p/ Máquina**, escolha se deseja manter ou omitir as linhas dos retalhos úteis e clique em **Baixar .DXF Final do Nesting**[cite: 15].

---

## 🧠 Lógica Matemática e Algoritmos Utilizados

### 1. Identificação Topológica de Peças vs. Furos (*Ray-Casting*)
Arquivos `.DXF` entregam entidades geométricas soltas sem hierarquia explícita[cite: 7]. O `server.js` ordena todos os contornos fechados da maior caixa delimitadora (*Bounding Box*) para a menor e dispara uma semirreta horizontal a partir dos vértices internos (`isPointInPolygon`)[cite: 7].
* Pelo **Teorema da Curva de Jordan (Par/Ímpar)**[cite: 7]:
  * Contornos contidos dentro de um número **par** (`0, 2...`) de polígonos maiores são classificados como **Peças Principais**[cite: 7].
  * Contornos contidos dentro de um número **ímpar** (`1, 3...`) são classificados como **Furos Internos** da peça ancestral direta[cite: 7].

### 2. Nesting In-Hole com Sincronia Matricial de 90°
Antes de alocar peças na chapa principal, a função `tryNestingInHoles()` verifica todos os furos internos que atingem o `Furo Mín. Útil`[cite: 15, 17].
* Descontando `2 * Kerf` das dimensões internas do furo, se uma peça menor do próprio pedido couber lá dentro (a `0°` ou `90°`), ela é alocada dentro do furo da peça mãe[cite: 17].
* Caso a peça mãe sofra rotação de `90°` ao entrar na chapa principal, a peça filha sofre automaticamente a mesma transformação ortogonal[cite: 17]:
  ```text
  rotRelX = child.relYInHost
  rotRelY = host.width - (child.relXInHost + child.basePlacedWidth)
  ```
  invertendo suas dimensões (`placedWidth` ↔ `placedHeight`) e rotacionando seus vértices para manter-se perfeitamente centralizada no furo[cite: 17].

### 3. Alocação MaxRects + Decomposição Côncava + Colisão True-Shape
A cada iteração do `nestingWorker.js`:
1. **Decomposição de Peças em "L" (`getSolidBoxesForPart`):** Peças côncavas de 6 vértices são subdivididas em suas 2 pernas retangulares sólidas exatas ao atualizar a lista de espaços livres (`freeRects`), liberando o vão vazio do "L" para outras peças[cite: 17].
2. **Colisão Poligonal Completa (`polygonsCollideTrueShape`):** Verifica 4 condições geométricas entre pares de peças[cite: 17]:
   * Filtro rápido por *Axis-Aligned Bounding Box (AABB)*[cite: 17];
   * Inclusão de vértices e pontos médios de arestas (`isPointInPoly`)[cite: 17];
   * Cruzamento vetorial entre segmentos de reta (`segmentsIntersect`)[cite: 17];
   * Distância perpendicular mínima ponto-segmento (`pointToSegmentDistSq < gap²`)[cite: 17].
3. **Compactação Gravitacional (*Shake-Down 2D*):** As peças posicionadas deslizam em passos sucessivos nos eixos `X` e `Y` até encostar no limite do `Kerf` (ou na largura do feixe de `0.4 mm` com **Corte Comum** ativo)[cite: 8, 15].

### 4. Extração Guilhotina de Retalhos Padronizados e Cálculo de Aproveitamento
Após compactar todas as peças, a área livre restante da chapa é fatiada iterativamente (`extractStandardRemnants`): seleciona-se o maior retângulo livre válido (`>= Retalho Mín.`), registra-se o bloco como retalho padronizado e subtrai-se sua caixa do espaço livre para garantir **zero sobreposição**[cite: 8].

O índice principal (**Aproveitamento na Área Consumida**) mede a eficiência real descontando a matéria-prima salva em retalhos padronizados[cite: 8]:

$$\text{Aproveitamento (\%)} = \left( \frac{\text{Área Útil das Peças}}{\text{Área Total da Chapa} - \text{Soma dos Retalhos Padronizados}} \right) \times 100$$

---

## 🔌 Endpoints da API

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| `GET` | `/api/hardware` | Retorna CPU, núcleos lógicos, limite de Workers da VPS, tamanho da fila e status de GPU[cite: 16]. |
| `POST` | `/api/upload-dxf` | Recebe o `.DXF` de peças (`multipart/form-data`), costura linhas e retorna os contornos extraídos[cite: 16]. |
| `POST` | `/api/upload-sheet-dxf` | Recebe o `.DXF` da chapa principal customizada e retorna seu polígono normalizado[cite: 16]. |
| `POST` | `/api/start-job` | Classifica peças e furos, registra o Job de cálculo e retorna `{ jobId, parts }`[cite: 16]. |
| `GET` | `/api/stream/:jobId` | Stream **SSE (`text/event-stream`)** emitindo eventos `queued`, `progress` e `done`[cite: 16]. |
| `GET` | `/api/sample-dxf` | Gera arquivos `.DXF` de exemplo (`?preset=icamento`, `trueshape`, `industrial`, `sheet_stepped`)[cite: 16]. |
