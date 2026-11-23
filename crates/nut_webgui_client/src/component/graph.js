import dagre from "@dagrejs/dagre";
import {
  getAttributeNumeric,
  into_debounced_fn,
  link_host_styles,
} from "../util.js";
import {
  select as d3_select,
  link as d3_link,
  curveBumpX,
  curveBumpY,
} from "d3";

/** @typedef {"rankdir" | "align" | "x" | "y" | "scale" } GraphAttributes */
/** @typedef {"TB" | "BT" | "LR" | "RL"} RankDirection */
/** @typedef {"UL" | "UR" | "DL" | "DR" } AlignDirection */

/**
 * @typedef Vector2
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef GraphState
 * @property {Vector2} position
 * @property {number} scale
 * @property {number} width
 * @property {number} height
 * @property {RankDirection} rankdir
 * @property {AlignDirection | undefined} align
 */

const PRIMARY_BUTTON_BITFLAG = 1;
const AUXILIARY_BUTTON_BITFLAG = 4;
const GRAB_STATE = "grabbing";

/** @typedef {0 | 1 | 2 | 3} PositionType */

/** @type {Record<string, PositionType>} */
const Position = {
  Top: 0,
  Right: 1,
  Bottom: 2,
  Left: 3,
};

const GRAPH_MARGIN = 16;
const ROW_PADDING = 12;
const CLUSTER_GAP = 64;
const ROW_GAP = 48;
const HEADING_GAP = 12;

class GraphNode extends HTMLElement {}
class GraphGroup extends GraphNode {}
class GraphLink extends GraphNode {}
/** Framed horizontal band with a heading. Clusters inside the same row are placed side by side. */
class GraphRow extends GraphNode {}
/** Independent part of the graph that is laid out on its own, e.g. everything of one UPSD. */
class GraphCluster extends GraphNode {}
/** Title of a row. */
class GraphHeading extends GraphNode {}

/**
 * @typedef LeafNode
 * @property {string} id
 * @property {string} html
 * @property {number} width
 * @property {number} height
 * @property {string | undefined} parent
 * @property {number} x Center of the node
 * @property {number} y Center of the node
 */

/**
 * @typedef LayoutLink
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string} class
 * @property {number} weight
 * @property {number} from_offset
 * @property {number} to_offset
 * @property {string | undefined} label
 * @property {number} label_width
 * @property {number} label_height
 */

/**
 * @typedef LayoutCluster
 * @property {{id: string, parent: string | undefined}[]} groups
 * @property {LeafNode[]} nodes
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef LayoutRow
 * @property {LayoutCluster[]} clusters
 * @property {{html: string, width: number, height: number} | undefined} heading
 * @property {boolean} framed
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @returns {LayoutCluster}
 */
function new_cluster() {
  return { groups: [], nodes: [], x: 0, y: 0, width: 0, height: 0 };
}

/**
 * @param {LayoutCluster[]} clusters
 * @param {{html: string, width: number, height: number} | undefined} heading
 * @param {boolean} framed
 * @returns {LayoutRow}
 */
function new_row(clusters, heading, framed) {
  return { clusters, heading, framed, x: 0, y: 0, width: 0, height: 0 };
}

/**
 * @param {Element} element
 * @param {string | undefined} parent
 * @returns {LeafNode}
 */
function read_leaf(element, parent) {
  return {
    id: element.id,
    html: element.innerHTML.trim(),
    width: getAttributeNumeric(element, "width") ?? element.clientWidth,
    height: getAttributeNumeric(element, "height") ?? element.clientHeight,
    parent,
    x: 0,
    y: 0,
  };
}

/**
 * @param {Element} element
 * @returns {LayoutLink}
 */
function read_link(element) {
  const label = element.innerHTML?.trim();

  return {
    id: element.id,
    from: element.getAttribute("from") ?? "",
    to: element.getAttribute("to") ?? "",
    class: element.className,
    weight: getAttributeNumeric(element, "weight") ?? 1,
    from_offset: getAttributeNumeric(element, "from-offset") ?? 0,
    to_offset: getAttributeNumeric(element, "to-offset") ?? 0,
    label: label && label.length > 1 ? label : undefined,
    label_width: element.clientWidth ?? 0,
    label_height: element.clientHeight ?? 0,
  };
}

/**
 * @param {Element} child
 * @param {LayoutCluster} cluster
 * @param {LayoutLink[]} links
 * @param {string | undefined} [parent]
 */
function collect_child(child, cluster, links, parent) {
  switch (child.nodeName) {
    case "NUT-GRAPH-GROUP": {
      cluster.groups.push({ id: child.id, parent });

      for (const inner of child.children) {
        collect_child(inner, cluster, links, child.id);
      }
      break;
    }
    case "NUT-GRAPH-NODE": {
      cluster.nodes.push(read_leaf(child, parent));
      break;
    }
    case "NUT-GRAPH-LINK": {
      links.push(read_link(child));
      break;
    }
    default:
      break;
  }
}

/**
 * @param {Element} element
 * @returns {{html: string, width: number, height: number}}
 */
function read_heading(element) {
  return {
    html: element.innerHTML.trim(),
    width: element.clientWidth,
    height: element.clientHeight,
  };
}

/**
 * Reads the rows, clusters, nodes and links from the (hidden) markup.
 *
 * Nodes that are not inside any row end up in a single implicit row without a frame, so a flat
 * graph keeps working.
 *
 * @param {Element} root_node
 * @returns {{rows: LayoutRow[], links: LayoutLink[]}}
 */
function parse_layout(root_node) {
  /** @type {LayoutRow[]} */
  const rows = [];
  /** @type {LayoutLink[]} */
  const links = [];
  /** @type {LayoutCluster | undefined} */
  let implicit = undefined;

  for (const child of root_node.children) {
    if (child.nodeName === "NUT-GRAPH-ROW") {
      const row = new_row([], undefined, true);
      rows.push(row);

      for (const row_child of child.children) {
        if (row_child.nodeName === "NUT-GRAPH-HEADING") {
          row.heading = read_heading(row_child);
        } else if (row_child.nodeName === "NUT-GRAPH-CLUSTER") {
          const cluster = new_cluster();
          row.clusters.push(cluster);

          for (const inner of row_child.children) {
            collect_child(inner, cluster, links);
          }
        }
      }
    } else if (child.nodeName === "NUT-GRAPH-LINK") {
      links.push(read_link(child));
    } else {
      if (!implicit) {
        implicit = new_cluster();
        rows.push(new_row([implicit], undefined, false));
      }

      collect_child(child, implicit, links);
    }
  }

  return { rows, links };
}

/**
 * Places the nodes of one cluster with dagre. After this call every node position is relative to
 * the top-left corner of the cluster.
 *
 * @param {LayoutCluster} cluster
 * @param {LayoutLink[]} links
 * @param {RankDirection} rankdir
 * @param {AlignDirection | undefined} align
 */
function layout_cluster(cluster, links, rankdir, align) {
  const node_ids = new Set(cluster.nodes.map((node) => node.id));

  const graph = new dagre.graphlib.Graph({
    multigraph: true,
    compound: true,
  })
    .setGraph({ marginx: 0, marginy: 0, rankdir, align })
    .setDefaultEdgeLabel(function () {
      return {};
    });

  for (const group of cluster.groups) {
    graph.setNode(group.id, { __type: "group" });
  }

  for (const group of cluster.groups) {
    if (group.parent) {
      graph.setParent(group.id, group.parent);
    }
  }

  for (const node of cluster.nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height });

    if (node.parent) {
      graph.setParent(node.id, node.parent);
    }
  }

  // NOTE: Links that leave the cluster do not affect the layout.
  for (const link of links) {
    if (node_ids.has(link.from) && node_ids.has(link.to)) {
      graph.setEdge(link.from, link.to, { weight: link.weight }, link.id);
    }
  }

  dagre.layout(graph);

  for (const node of cluster.nodes) {
    const layout = graph.node(node.id);

    node.x = layout.x;
    node.y = layout.y;
  }

  const has_nodes = cluster.nodes.length > 0;
  const min_x = Math.min(...cluster.nodes.map((node) => node.x - node.width / 2));
  const min_y = Math.min(...cluster.nodes.map((node) => node.y - node.height / 2));
  const max_x = Math.max(...cluster.nodes.map((node) => node.x + node.width / 2));
  const max_y = Math.max(...cluster.nodes.map((node) => node.y + node.height / 2));

  for (const node of cluster.nodes) {
    move_node(node, -min_x, -min_y);
  }

  cluster.width = has_nodes ? max_x - min_x : 0;
  cluster.height = has_nodes ? max_y - min_y : 0;
}

/**
 * @param {LeafNode} node
 * @param {number} dx
 * @param {number} dy
 */
function move_node(node, dx, dy) {
  node.x += dx;
  node.y += dy;
}

/**
 * Lays out every cluster and packs them into rows. A row is a frame with a heading, clusters
 * inside it are placed side by side. Cluster, row and node positions are absolute after this
 * call.
 *
 * @param {LayoutRow[]} rows
 * @param {LayoutLink[]} links
 * @param {RankDirection} rankdir
 * @param {AlignDirection | undefined} align
 * @returns {{width: number, height: number}}
 */
function layout_rows(rows, links, rankdir, align) {
  let y = GRAPH_MARGIN;
  let width = 2 * GRAPH_MARGIN;

  for (const row of rows) {
    const padding = row.framed ? ROW_PADDING : 0;
    const heading_block = row.heading ? row.heading.height + HEADING_GAP : 0;
    let content_width = 0;
    let content_height = 0;

    for (const cluster of row.clusters) {
      layout_cluster(cluster, links, rankdir, align);

      cluster.x = content_width;
      content_width += cluster.width + CLUSTER_GAP;
      content_height = Math.max(content_height, cluster.height);
    }

    content_width = Math.max(0, content_width - CLUSTER_GAP);

    row.x = GRAPH_MARGIN;
    row.y = y;
    row.width = Math.max(content_width, row.heading?.width ?? 0) + 2 * padding;
    row.height = heading_block + content_height + 2 * padding;

    for (const cluster of row.clusters) {
      cluster.x += row.x + padding;
      cluster.y = row.y + padding + heading_block;

      for (const node of cluster.nodes) {
        move_node(node, cluster.x, cluster.y);
      }
    }

    width = Math.max(width, row.x + row.width + GRAPH_MARGIN);
    y += row.height + ROW_GAP;
  }

  const height = rows.length > 0 ? y - ROW_GAP + GRAPH_MARGIN : 2 * GRAPH_MARGIN;

  return { width, height };
}

/**
 * @param {string} value
 * @returns {AlignDirection | undefined}
 */
function try_into_align(value) {
  switch (value.trim().toUpperCase()) {
    case "DL":
    case "DR":
    case "UL":
    case "UR":
      return /** @type {AlignDirection} */ (value);
    default:
      return undefined;
  }
}

/**
 * @param {string} value
 * @returns {RankDirection | undefined}
 */
function try_into_rankdir(value) {
  switch (value.trim().toUpperCase()) {
    case "BT":
    case "LR":
    case "RL":
    case "TB":
      return /** @type {RankDirection} */ (value);
    default:
      return undefined;
  }
}

/**
 * @param {RankDirection} rankdir
 * @returns {{
 *  src_position: PositionType,
 *  dest_position: PositionType,
 *  curvature: import("d3").CurveFactory
 * }}
 */
function into_edge_config(rankdir) {
  switch (rankdir) {
    case "BT":
      return {
        src_position: Position.Top,
        dest_position: Position.Bottom,
        curvature: curveBumpY,
      };
    case "LR":
      return {
        src_position: Position.Right,
        dest_position: Position.Left,
        curvature: curveBumpX,
      };
    case "RL":
      return {
        src_position: Position.Left,
        dest_position: Position.Right,
        curvature: curveBumpX,
      };
    case "TB":
    default:
      return {
        src_position: Position.Bottom,
        dest_position: Position.Top,
        curvature: curveBumpY,
      };
  }
}

/**
 * @param {Element} element
 * @param {GraphAttributes} name
 * @returns {RankDirection | undefined}
 */
function getAttributeRankdir(element, name) {
  const value = element.getAttribute(name);
  return value ? try_into_rankdir(value) : undefined;
}

/**
 * @param {Element} element
 * @param {GraphAttributes} name
 * @returns {AlignDirection | undefined}
 */
function getAttributeAlign(element, name) {
  const value = element.getAttribute(name);
  return value ? try_into_align(value) : undefined;
}

/**
 * Calculates the edge connection point on the rectangle.
 *
 * # Example
 *
 *   Relative         Current
 *     Node            Node
 *
 *                    position: Position.Right
 *   ┌─────┐          ┌─────┐
 *   │ OH, │          │     │
 *   │ HI  │       ┌─►*  o◄─┼──┐
 *   │MARK!│       │  │     │  │
 *   └─────┘       │  └─────┘  │
 *                 │          rect x and y is the origin point of the rectangle
 *                 │
 *               the connection point function calculates
 *
 * @param {{x:number, y:number, width:number, height:number}} rect Rectangle object
 * @param {PositionType} position direction of the rectangle 'relative' to target node
 * @param {number} [offset] Optional offset value in pixels
 * @returns {Vector2}
 */
function get_connection_point(rect, position, offset) {
  const dw = rect.width / 2;
  const dh = rect.height / 2;
  const edge_offset = offset ?? 0;

  switch (position) {
    case Position.Left:
      return {
        x: rect.x - dw,
        y: rect.y + edge_offset,
      };
    case Position.Top:
      return {
        x: rect.x + edge_offset,
        y: rect.y - dh,
      };
    case Position.Right:
      return {
        x: rect.x + dw,
        y: rect.y + edge_offset,
      };
    case Position.Bottom:
    default:
      return {
        x: rect.x + edge_offset,
        y: rect.y + dh,
      };
  }
}

class Graph extends HTMLElement {
  /** @type {AbortController | undefined} */
  #abort_controller;

  /** @type {Element} */
  #container;

  /** @type{ElementInternals} */
  #internals;

  /** @type{Vector2 | undefined} */
  #pointer_state;

  /** @type{ResizeObserver} */
  #resize_observer;

  /** @type{MutationObserver} */
  #mutation_observer;

  /** @type {ShadowRoot} */
  #shadow_root;

  /** @type {import("d3").Selection<SVGSVGElement, any, null, undefined>} */
  #svg;

  /** @type{GraphState} */
  #state;

  /** @type {GraphAttributes[]} */
  static observedAttributes = ["x", "y", "scale", "rankdir", "align"];

  constructor() {
    super();

    this.#internals = this.attachInternals();
    this.#shadow_root = this.attachShadow({ mode: "closed" });
    link_host_styles(this.#shadow_root);

    const container = document.createElement("div");
    container.style.display = "inline-block";
    container.style.height = "100%";
    container.style.width = "100%";

    this.#container = container;
    this.#shadow_root.append(container);
    this.#state = {
      align: undefined,
      height: 0,
      position: { x: 0, y: 0 },
      rankdir: "TB",
      scale: 1,
      width: 0,
    };
    this.#pointer_state = undefined;
    this.#resize_observer = new ResizeObserver(
      into_debounced_fn((entries) => this.#resize(entries), { duration: 200 }),
    );
    this.#mutation_observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== this) {
          const target = /** @type{ Element} */ (record.target);

          if (
            record.type === "attributes" &&
            record.attributeName &&
            record.oldValue === target.getAttribute(record.attributeName)
          ) {
            continue;
          } else {
            this.#lazy_render();
            return;
          }
        }
      }
    });
  }

  connectedCallback() {
    const rankdir = getAttributeRankdir(this, "rankdir") ?? "TB";
    const align = getAttributeAlign(this, "align");
    const pos_x = getAttributeNumeric(this, "x") ?? 0;
    const pos_y = getAttributeNumeric(this, "y") ?? 0;
    const scale = getAttributeNumeric(this, "scale") ?? 1;

    this.#abort_controller?.abort();
    this.#abort_controller = new AbortController();
    this.#mutation_observer.observe(this, {
      subtree: true,
      childList: true,
      attributeOldValue: true,
      attributes: true,
    });

    this.addEventListener(
      "pointermove",
      (e) => {
        if (this.#internals.states.has(GRAB_STATE)) {
          const cmp_flag =
            e.pointerType === "mouse"
              ? AUXILIARY_BUTTON_BITFLAG
              : PRIMARY_BUTTON_BITFLAG;

          if (e.buttons === cmp_flag && this.#pointer_state !== undefined) {
            const delta_x = this.#pointer_state.x - e.screenX;
            const delta_y = this.#pointer_state.y - e.screenY;
            const { x, y } = this.#state.position;

            this.#transform(x + delta_x, y + delta_y, this.#state.scale);
          }

          this.#pointer_state = { x: e.screenX, y: e.screenY };
        }
      },
      { signal: this.#abort_controller.signal, passive: true },
    );

    this.addEventListener(
      "pointerdown",
      (e) => {
        if (
          e.pointerType !== "mouse" ||
          (e.pointerType === "mouse" && e.buttons === AUXILIARY_BUTTON_BITFLAG)
        ) {
          this.#internals.states.add(GRAB_STATE);
        }
      },
      { signal: this.#abort_controller.signal, passive: true },
    );

    const cancel_action = () => {
      if (this.#internals.states.has(GRAB_STATE)) {
        this.#internals.states.delete(GRAB_STATE);
        this.#pointer_state = undefined;
      }
    };

    this.addEventListener("pointerup", cancel_action, {
      signal: this.#abort_controller.signal,
      passive: true,
    });

    this.addEventListener("pointercancel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancel_action();
    });

    this.addEventListener(
      "wheel",
      (e) => {
        const pivot = { x: this.clientWidth / 2, y: this.clientHeight / 2 };
        const scale = Math.max(
          this.#state.scale - Math.sign(e.deltaY) * 0.1,
          0.1,
        );
        this.#scale(scale, pivot);
      },
      { signal: this.#abort_controller.signal, passive: true },
    );

    this.#state = {
      width: 0,
      height: 0,
      rankdir,
      align,
      position: { x: pos_x, y: pos_y },
      scale,
    };
    this.#render();
  }

  disconnectedCallback() {
    this.#resize_observer.disconnect();
    this.#mutation_observer.disconnect();
  }

  /**
   * @param {GraphAttributes} name
   * @param {string} old_value
   * @param {string} new_value
   */
  attributeChangedCallback(name, old_value, new_value) {
    const target = this.#container;

    if (!target || old_value === new_value) {
      return;
    }

    switch (name) {
      case "align": {
        this.#state.align = try_into_align(new_value);
        this.#lazy_render();
        break;
      }
      case "rankdir": {
        this.#state.rankdir = try_into_rankdir(new_value) ?? "TB";
        this.#transform(0, 0, this.#state.scale);
        this.#lazy_render();
        break;
      }
      case "x": {
        const pos_x = Number(new_value);

        if (!isNaN(pos_x)) {
          this.#transform(pos_x, this.#state.position.y, this.#state.scale);
        }
        break;
      }
      case "y": {
        const pos_y = Number(new_value);

        if (!isNaN(pos_y)) {
          this.#transform(this.#state.position.x, pos_y, this.#state.scale);
        }
        break;
      }
      case "scale": {
        const scale = Number(new_value);

        if (!isNaN(scale)) {
          const pivot = { x: this.clientWidth / 2, y: this.clientHeight / 2 };
          this.#scale(Math.max(scale, 0.1), pivot);
        }
        break;
      }
      default:
        break;
    }
  }

  #render() {
    this.#resize_observer.unobserve(this.#container);

    const { rankdir, align, position, scale } = this.#state;
    const temp_layout = document.createElement("div");

    for (const child of this.children) {
      temp_layout.appendChild(child.cloneNode(true));
    }

    this.#container.append(temp_layout);

    setTimeout(() => {
      const { rows, links } = parse_layout(temp_layout);
      const layout = layout_rows(rows, links, rankdir, align);
      const clusters = rows.flatMap((row) => row.clusters);

      /** @type {Map<string, LeafNode>} */
      const nodes = new Map();

      for (const cluster of clusters) {
        for (const node of cluster.nodes) {
          nodes.set(node.id, node);
        }
      }

      const svg_root = document.createElement("div");
      svg_root.style.display = "inline-block";
      svg_root.style.height = "100%";
      svg_root.style.width = "100%";

      const graph_height = Math.max(this.scrollHeight, layout.height);
      const graph_width = Math.max(this.scrollWidth, layout.width);
      const svg_container = d3_select(svg_root);
      const svg = svg_container
        .append("svg")
        .attr("xmlns", "http://www.w3.org/2000/svg")
        .attr("height", graph_height)
        .attr("width", graph_width)
        .attr("min-height", graph_height)
        .attr("min-width", graph_width)
        .attr("style", "object-fit: none;")
        .attr("viewBox", `0 0 ${graph_width} ${graph_height}`);

      const group = svg
        .append("g")
        .attr(
          "transform",
          `translate(${-position.x} ${-position.y}) scale(${scale})`,
        );

      const edge_config = into_edge_config(rankdir);

      for (const row of rows) {
        if (row.framed) {
          group
            .append("rect")
            .attr("x", row.x)
            .attr("y", row.y)
            .attr("width", row.width)
            .attr("height", row.height)
            .attr("rx", 8)
            .attr(
              "style",
              "fill:color-mix(in oklab, var(--color-base-300) 40%, transparent);" +
                "stroke:var(--color-base-300);stroke-width:1;stroke-dasharray:6 6",
            );
        }

        if (row.heading) {
          group
            .append("foreignObject")
            .attr("x", row.x + ROW_PADDING)
            .attr("y", row.y + ROW_PADDING)
            .attr("width", row.heading.width)
            .attr("height", row.heading.height)
            .append("xhtml:div")
            .html(row.heading.html);
        }
      }

      // NOTE: Links are drawn first so that nodes are always on top of them.
      for (const link of links) {
        const src_node = nodes.get(link.from);
        const dest_node = nodes.get(link.to);

        if (!src_node || !dest_node) {
          continue;
        }

        const start = get_connection_point(
          src_node,
          edge_config.src_position,
          link.from_offset,
        );

        const dest = get_connection_point(
          dest_node,
          edge_config.dest_position,
          link.to_offset,
        );
        const svg_path = group
          .append("path")
          .attr(
            "d",
            d3_link(edge_config.curvature)({
              source: [start.x, start.y],
              target: [dest.x, dest.y],
            }),
          );

        if (link.class) {
          svg_path.attr("class", link.class);
        } else {
          svg_path.attr("style", "fill:none;stroke:green;stroke-width:3");
        }

        if (link.label && link.label_width && link.label_height) {
          const labelX = start.x + (dest.x - start.x) / 2;
          const labelY = start.y + (dest.y - start.y) / 2;

          group
            .append("foreignObject")
            .attr("x", labelX - link.label_width / 2)
            .attr("y", labelY - link.label_height / 2)
            .attr("width", link.label_width)
            .attr("height", link.label_height)
            .append("xhtml:div")
            .html(link.label);
        }
      }

      for (const node of nodes.values()) {
        group
          .append("foreignObject")
          .attr("x", node.x - node.width / 2)
          .attr("y", node.y - node.height / 2)
          .attr("width", node.width)
          .attr("height", node.height)
          .append("xhtml:div")
          .html(node.html);
      }

      this.#state.height = graph_height;
      this.#state.width = graph_width;
      this.#container.replaceChildren(...svg_root.children);
      this.#svg = svg;
      this.#resize_observer.observe(this.#container);
    }, 0);
  }

  #lazy_render = into_debounced_fn(() => this.#render(), { duration: 33 });

  /**
   * @param {ResizeObserverEntry[]} entries
   */
  #resize(entries) {
    for (const entry of entries) {
      if (entry.target === this.#container) {
        const height = Math.max(entry.target.scrollHeight, this.#state.height);
        const width = Math.max(entry.target.scrollWidth, this.#state.width);

        this.#svg
          ?.attr("height", height)
          .attr("width", width)
          .attr("viewBox", `0 0 ${width} ${height}`);
        this.#state.height = height;
        this.#state.width = width;

        return;
      }
    }
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} scale
   */
  #transform(x, y, scale) {
    this.#state.position.x = x;
    this.#state.position.y = y;
    this.#state.scale = scale;
    this.setAttribute("x", x.toString());
    this.setAttribute("y", y.toString());
    this.setAttribute("scale", scale.toString());

    this.#svg
      ?.select("g")
      ?.attr("transform", `translate(${-x} ${-y}) scale(${scale})`);
  }

  /**
   * @param {number} value
   * @param {Vector2} screen_pivot
   */
  #scale(value, screen_pivot) {
    const { scale, position } = this.#state;
    const pivot_x = (position.x + screen_pivot.x) / scale;
    const pivot_y = (position.y + screen_pivot.y) / scale;
    const target_x = pivot_x * value - screen_pivot.x;
    const target_y = pivot_y * value - screen_pivot.y;

    this.#transform(target_x, target_y, value);
  }
}

customElements.define("nut-graph", Graph);
customElements.define("nut-graph-node", GraphNode);
customElements.define("nut-graph-link", GraphLink);
customElements.define("nut-graph-group", GraphGroup);
customElements.define("nut-graph-row", GraphRow);
customElements.define("nut-graph-cluster", GraphCluster);
customElements.define("nut-graph-heading", GraphHeading);
