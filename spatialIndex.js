// spatialIndex.js
'use strict';

/**
 * Estrutura R-Tree 2D de alta performance para busca espacial de caixas envolventes (AABBs).
 */
class RTree2D {
  /**
   * @param {number} maxEntries - Número máximo de filhos por nó antes de split
   */
  constructor(maxEntries = 8) {
    this.maxEntries = Math.max(4, maxEntries);
    this.minEntries = Math.max(2, Math.ceil(this.maxEntries * 0.4));
    this.clear();
  }

  clear() {
    this.root = this._createNode(true, 1);
    this.size = 0;
  }

  _createNode(leaf, height) {
    return {
      children: [],
      leaf,
      height,
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
  }

  /**
   * Insere um item espacial na R-Tree.
   * @param {{ minX: number, minY: number, maxX: number, maxY: number, data: any }} item
   */
  insert(item) {
    this._insert(item, this.root.height - 1);
    this.size++;
  }

  /**
   * Carregamento em lote (Bulk Load Sort-Tile-Recursive) em O(N log N).
   * @param {Array<{ minX: number, minY: number, maxX: number, maxY: number, data: any }>} items
   */
  loadBulk(items) {
    if (!items || items.length === 0) return;
    if (items.length <= this.maxEntries) {
      for (const it of items) this.insert(it);
      return;
    }

    const sorted = [...items].sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
    const buildLevel = (nodes, isLeaf, height) => {
      const parents = [];
      const sliceSize = Math.ceil(Math.sqrt(nodes.length / this.maxEntries)) * this.maxEntries;

      for (let i = 0; i < nodes.length; i += sliceSize) {
        const slice = nodes.slice(i, i + sliceSize).sort((a, b) => (a.minY + a.maxY) - (b.minY + b.maxY));
        for (let j = 0; j < slice.length; j += this.maxEntries) {
          const group = slice.slice(j, j + this.maxEntries);
          const parent = this._createNode(isLeaf, height);
          parent.children = group;
          this._calcBBox(parent);
          parents.push(parent);
        }
      }
      if (parents.length === 1) return parents[0];
      return buildLevel(parents, false, height + 1);
    };

    this.root = buildLevel(sorted, true, 1);
    this.size = items.length;
  }

  /**
   * Busca todos os itens cujas AABBs interceptam a caixa de consulta.
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bbox
   * @returns {Array<any>}
   */
  search(bbox) {
    const results = [];
    const stack = [this.root];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!this._intersects(bbox, node)) continue;

      if (node.leaf) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (this._intersects(bbox, child)) {
            results.push(child.data !== undefined ? child.data : child);
          }
        }
      } else {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (this._intersects(bbox, child)) {
            stack.push(child);
          }
        }
      }
    }
    return results;
  }

  _insert(item, level) {
    const envelope = [];
    const node = this._chooseSubtree(item, this.root, level, envelope);
    node.children.push(item);
    this._extendBBox(node, item);

    while (level >= 0) {
      if (envelope[level].children.length > this.maxEntries) {
        this._split(envelope, level);
        level--;
      } else {
        break;
      }
    }
    this._adjustParentBBoxes(item, envelope, level);
  }

  _chooseSubtree(item, node, level, path) {
    while (true) {
      path.push(node);
      if (node.leaf || path.length - 1 === level) break;

      let minArea = Infinity;
      let minEnlargement = Infinity;
      let targetNode = null;

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const area = (child.maxX - child.minX) * (child.maxY - child.minY);
        const enlargement = this._enlargedArea(child, item) - area;

        if (enlargement < minEnlargement) {
          minEnlargement = enlargement;
          minArea = area < minArea ? area : minArea;
          targetNode = child;
        } else if (enlargement === minEnlargement && area < minArea) {
          minArea = area;
          targetNode = child;
        }
      }
      node = targetNode || node.children[0];
    }
    return node;
  }

  _split(insertPath, level) {
    const node = insertPath[level];
    const M = node.children.length;
    const m = this.minEntries;

    this._chooseSplitAxis(node, m, M);
    const splitIndex = this._chooseSplitIndex(node, m, M);

    const newNode = this._createNode(node.leaf, node.height);
    newNode.children = node.children.splice(splitIndex, node.children.length - splitIndex);

    this._calcBBox(node);
    this._calcBBox(newNode);

    if (level > 0) {
      insertPath[level - 1].children.push(newNode);
    } else {
      const newRoot = this._createNode(false, node.height + 1);
      newRoot.children.push(node, newNode);
      this._calcBBox(newRoot);
      this.root = newRoot;
    }
  }

  _chooseSplitAxis(node, m, M) {
    const distMarginX = this._allDistMargin(node, m, M, true);
    const distMarginY = this._allDistMargin(node, m, M, false);
    if (distMarginX < distMarginY) {
      node.children.sort((a, b) => a.minX - b.minX || a.maxX - b.maxX);
    }
  }

  _allDistMargin(node, m, M, byX) {
    node.children.sort(byX
      ? (a, b) => a.minX - b.minX || a.maxX - b.maxX
      : (a, b) => a.minY - b.minY || a.maxY - b.maxY
    );
    let margin = 0;
    for (let i = m; i <= M - m; i++) {
      const left = this._tempBBox(node.children, 0, i);
      const right = this._tempBBox(node.children, i, M);
      margin += (left.maxX - left.minX) + (left.maxY - left.minY) +
                (right.maxX - right.minX) + (right.maxY - right.minY);
    }
    return margin;
  }

  _chooseSplitIndex(node, m, M) {
    let minOverlap = Infinity;
    let minArea = Infinity;
    let index = m;

    for (let i = m; i <= M - m; i++) {
      const bbox1 = this._tempBBox(node.children, 0, i);
      const bbox2 = this._tempBBox(node.children, i, M);
      const overlap = this._intersectionArea(bbox1, bbox2);
      const area = (bbox1.maxX - bbox1.minX) * (bbox1.maxY - bbox1.minY) +
                   (bbox2.maxX - bbox2.minX) * (bbox2.maxY - bbox2.minY);

      if (overlap < minOverlap) {
        minOverlap = overlap;
        index = i;
        minArea = area < minArea ? area : minArea;
      } else if (overlap === minOverlap && area < minArea) {
        minArea = area;
        index = i;
      }
    }
    return index;
  }

  _tempBBox(children, start, end) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = start; i < end; i++) {
      const c = children[i];
      if (c.minX < minX) minX = c.minX;
      if (c.minY < minY) minY = c.minY;
      if (c.maxX > maxX) maxX = c.maxX;
      if (c.maxY > maxY) maxY = c.maxY;
    }
    return { minX, minY, maxX, maxY };
  }

  _calcBBox(node) {
    const b = this._tempBBox(node.children, 0, node.children.length);
    node.minX = b.minX;
    node.minY = b.minY;
    node.maxX = b.maxX;
    node.maxY = b.maxY;
  }

  _extendBBox(a, b) {
    if (b.minX < a.minX) a.minX = b.minX;
    if (b.minY < a.minY) a.minY = b.minY;
    if (b.maxX > a.maxX) a.maxX = b.maxX;
    if (b.maxY > a.maxY) a.maxY = b.maxY;
  }

  _adjustParentBBoxes(bbox, path, level) {
    for (let i = level; i >= 0; i--) {
      this._extendBBox(path[i], bbox);
    }
  }

  _enlargedArea(a, b) {
    return (Math.max(a.maxX, b.maxX) - Math.min(a.minX, b.minX)) *
           (Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY));
  }

  _intersectionArea(a, b) {
    const minX = Math.max(a.minX, b.minX);
    const minY = Math.max(a.minY, b.minY);
    const maxX = Math.min(a.maxX, b.maxX);
    const maxY = Math.min(a.maxY, b.maxY);
    return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  }

  _intersects(a, b) {
    return b.minX <= a.maxX && b.minY <= a.maxY && b.maxX >= a.minX && b.maxY >= a.minY;
  }
}

module.exports = { RTree2D };