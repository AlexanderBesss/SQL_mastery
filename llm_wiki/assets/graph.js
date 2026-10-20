/* Hand-authored graph for the LLM Wiki investigation.
   No dependencies. Canvas force layout with drag, hover, search, and filters. */
(() => {
  'use strict';

  const NODES = [
    // Report pages
    { id: 'overview', label: 'Overview', type: 'page', page: 'index.html', summary: 'The verdicts, decision matrix, myth check, key numbers, and scope of the investigation.' },
    { id: 'idea', label: 'The idea', type: 'page', page: '01_idea.html', summary: 'From RAG to compile-once knowledge: why a persistent, compiled wiki changes the economics of synthesis.' },
    { id: 'architecture', label: 'Architecture', type: 'page', page: '02_architecture.html', summary: 'The three layers, the schema contract, page types, index/log, ingest/query/lint, scale, and security.' },
    { id: 'graph-page', label: 'Markdown as graph', type: 'page', page: '03_graph.html', summary: 'Wikilinks, backlinks, typed edges, graph views, graph indexes, and the boundary between a folder and a graph database.' },
    { id: 'build', label: 'Build it', type: 'page', page: '04_build.html', summary: 'An eight-step setup, copyable templates, prompts, tooling, publishing, and a 30-day plan.' },
    { id: 'evidence', label: 'Evidence & limits', type: 'page', page: '05_evidence.html', summary: 'What the benchmarks show, the failure modes that kill wikis, and the strict list of when not to use the pattern.' },

    // Concepts
    { id: 'raw', label: 'Raw sources', type: 'concept', page: '02_architecture.html#layers', summary: 'Immutable articles, papers, transcripts, images, and data. The source of truth the agent may read but never edit.' },
    { id: 'wiki', label: 'Wiki pages', type: 'concept', page: '02_architecture.html#layers', summary: 'The LLM-owned layer: summaries, entities, concepts, comparisons, syntheses, and an overview.' },
    { id: 'schema', label: 'Schema / AGENTS.md', type: 'concept', page: '02_architecture.html#schema', summary: 'The written contract that defines ownership, page types, citations, workflows, and boundaries.' },
    { id: 'index', label: 'index.md', type: 'concept', page: '02_architecture.html#index-log', summary: 'A content-oriented catalog the agent reads first. Works to roughly 100 sources; rebuild it during lint.' },
    { id: 'log', label: 'log.md', type: 'concept', page: '02_architecture.html#index-log', summary: 'An append-only chronological record of ingests, queries, lints, renames, and reviews.' },
    { id: 'ingest', label: 'Ingest', type: 'concept', page: '02_architecture.html#ingest', summary: 'Read a source, discuss it, propose pages, write them, update the index and log, then review the diff.' },
    { id: 'query', label: 'Query', type: 'concept', page: '02_architecture.html#query', summary: 'Read the index, open only relevant pages, follow links, answer with citations, and file reusable answers back.' },
    { id: 'lint', label: 'Lint', type: 'concept', page: '02_architecture.html#lint', summary: 'A two-layer health check: deterministic link/index/source checks plus LLM judgment and human adjudication.' },
    { id: 'wikilinks', label: 'Wikilinks', type: 'concept', page: '03_graph.html#links', summary: 'Links such as [[concept-rag]] that become directed edges between pages. Plain links say "mentions," not why.' },
    { id: 'backlinks', label: 'Backlinks', type: 'concept', page: '03_graph.html#views', summary: 'The reverse edge: which pages point here. The feature that turns a folder into a navigable network.' },
    { id: 'graphview', label: 'Graph view', type: 'concept', page: '03_graph.html#views', summary: 'A visualization of nodes and edges. Good for shape, hubs, and orphans; not a query engine.' },
    { id: 'typed', label: 'Typed edges', type: 'concept', page: '03_graph.html#typed', summary: 'Frontmatter relationships with a predicate, source, evidence, confidence, and status. Optional, but useful for real questions.' },
    { id: 'okf', label: 'Open Knowledge Format', type: 'concept', page: '05_evidence.html#ecosystem', summary: 'Google Cloud\'s markdown + YAML-frontmatter bundle spec. v0.2 adds provenance, trust, lifecycle, and attestation.' },
    { id: 'rag', label: 'RAG baseline', type: 'concept', page: '01_idea.html#rag', summary: 'Retrieve chunks at query time and synthesize. Great for point lookups; no accumulation across queries.' },
    { id: 'memex', label: 'Memex / prior art', type: 'concept', page: '01_idea.html#prior-art', summary: 'Bush\'s 1945 associative knowledge store, Zettelkasten, wikis, and graph views. Karpathy\'s twist is the LLM maintainer.' },
    { id: 'compounding', label: 'Compounding', type: 'concept', page: '01_idea.html#compounding', summary: 'Each source and each filed answer can enrich the next question. The same loop can compound errors if provenance is weak.' },
    { id: 'provenance', label: 'Provenance', type: 'concept', page: '05_evidence.html#mitigations', summary: 'Every claim resolves to a raw source coordinate. The difference between an auditable wiki and a confident one.' },
    { id: 'human-gate', label: 'Human review gate', type: 'concept', page: '05_evidence.html#mitigations', summary: 'The agent drafts; a human promotes to trusted. Without this, unreviewed output becomes evidence.' },

    // Tools / ecosystem
    { id: 'obsidian', label: 'Obsidian', type: 'tool', page: '04_build.html#tooling', summary: 'Markdown editor with backlinks, local/global graph view, and plugins. The reference viewer, not a requirement.' },
    { id: 'clipper', label: 'Web Clipper', type: 'tool', page: '04_build.html#tooling', summary: 'Converts web articles to markdown in the vault. The usual way to fill raw/ with sources.' },
    { id: 'qmd', label: 'qmd', type: 'tool', page: '04_build.html#tooling', summary: 'Local hybrid BM25/vector search with LLM reranking; CLI + MCP. Karpathy recommends it for larger wikis.' },
    { id: 'ki', label: 'ki / Neo4j', type: 'tool', page: '03_graph.html#indexes', summary: 'A deterministic graph index over markdown: Vault → Folder → Document → Section, with HAS, NEXT_SECTION, and LINKS_TO.' },
    { id: 'graphify', label: 'graphify', type: 'tool', page: '04_build.html#tooling', summary: 'A skill that turns code, docs, papers, and images into a queryable knowledge graph. Author claims large token savings.' },
    { id: 'git', label: 'Git', type: 'tool', page: '02_architecture.html#git', summary: 'Version history, diffs, branches, and rollback. The wiki is a repository of markdown; treat it like code.' },

    // Failure modes / risks
    { id: 'drift', label: 'Source drift', type: 'risk', page: '05_evidence.html#failure-modes', summary: 'A source changes or is superseded, but the wiki page still states the old claim with confidence.' },
    { id: 'hallucination', label: 'Compounding errors', type: 'risk', page: '05_evidence.html#failure-modes', summary: 'A plausible wrong summary becomes a prior; other pages cite it; the wiki becomes internally consistent and externally wrong.' },
    { id: 'permissions', label: 'Permissions', type: 'risk', page: '05_evidence.html#failure-modes', summary: 'Plain markdown has no per-page ACL. A shared vault leaks everything to everyone.' },
    { id: 'injection', label: 'Prompt injection', type: 'risk', page: '02_architecture.html#security', summary: 'A raw source contains instructions. An agent with tools may follow them. Sources must be treated as data.' },
    { id: 'bloat', label: 'Volume bloat', type: 'risk', page: '05_evidence.html#failure-modes', summary: 'The agent writes pages because it can. The wiki grows faster than it is read and becomes noise.' },
    { id: 'index-drift', label: 'Index drift', type: 'risk', page: '05_evidence.html#failure-modes', summary: 'index.md falls out of sync with the files because incremental updates are unreliable. Rebuild it during lint.' },
    { id: 'circular-lint', label: 'Circular lint', type: 'risk', page: '05_evidence.html#failure-modes', summary: 'The same model that wrote the page grades the page. It finds the same plausible story convincing twice.' },
    { id: 'cost', label: 'Cost blowup', type: 'risk', page: '05_evidence.html#benchmarks', summary: 'Ingest touches many pages; queries read full pages; retries add up. Measure tokens per successful answer.' }
  ];

  const EDGES = [
    // Report structure
    ['overview', 'idea'], ['overview', 'architecture'], ['overview', 'graph-page'], ['overview', 'build'], ['overview', 'evidence'],
    ['idea', 'rag'], ['idea', 'wiki'], ['idea', 'compounding'], ['idea', 'memex'],
    ['architecture', 'raw'], ['architecture', 'wiki'], ['architecture', 'schema'], ['architecture', 'index'], ['architecture', 'log'], ['architecture', 'ingest'], ['architecture', 'query'], ['architecture', 'lint'],
    ['graph-page', 'wikilinks'], ['graph-page', 'backlinks'], ['graph-page', 'graphview'], ['graph-page', 'typed'], ['graph-page', 'ki'],
    ['build', 'obsidian'], ['build', 'clipper'], ['build', 'qmd'], ['build', 'graphify'], ['build', 'git'], ['build', 'schema'],
    ['evidence', 'okf'], ['evidence', 'provenance'], ['evidence', 'human-gate'], ['evidence', 'drift'], ['evidence', 'hallucination'], ['evidence', 'permissions'], ['evidence', 'injection'], ['evidence', 'bloat'], ['evidence', 'index-drift'], ['evidence', 'circular-lint'], ['evidence', 'cost'], ['evidence', 'rag'],

    // Core relationships
    ['raw', 'wiki'], ['wiki', 'schema'], ['wiki', 'index'], ['wiki', 'log'],
    ['ingest', 'query'], ['query', 'lint'], ['lint', 'ingest'],
    ['wikilinks', 'backlinks'], ['backlinks', 'graphview'], ['wikilinks', 'typed'],
    ['typed', 'ki'], ['index', 'graphview'], ['log', 'lint'],
    ['qmd', 'wiki'], ['clipper', 'raw'], ['obsidian', 'graphview'], ['git', 'wiki'],
    ['graphify', 'graph-page'], ['okf', 'schema'], ['provenance', 'human-gate'],
    ['human-gate', 'wiki'], ['compounding', 'wiki'], ['memex', 'compounding'], ['rag', 'idea'],
    ['drift', 'hallucination'], ['hallucination', 'circular-lint'], ['injection', 'raw'],
    ['permissions', 'wiki'], ['bloat', 'cost'], ['index-drift', 'lint'],
    ['circular-lint', 'lint'], ['cost', 'query'], ['ki', 'graphview'],
    ['qmd', 'index'], ['typed', 'provenance']
  ];

  const TYPE_LABEL = { page: 'report page', concept: 'concept', tool: 'tool / ecosystem', risk: 'failure mode / risk' };
  const TYPE_RANK = { page: 0, concept: 1, tool: 2, risk: 3 };
  const FONT_PAGE = '700 11px system-ui, -apple-system, Segoe UI, sans-serif';
  const FONT_NODE = '10px system-ui, -apple-system, Segoe UI, sans-serif';

  const canvas = document.getElementById('wiki-graph');
  const stage = document.getElementById('graph-stage');
  if (!canvas || !stage) return;
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('graph-tooltip');
  const info = document.getElementById('graph-info');
  const searchInput = document.getElementById('graph-search');
  const countEl = document.getElementById('graph-count');
  const resetBtn = document.getElementById('graph-reset');
  const pauseBtn = document.getElementById('graph-pause');
  const chips = Array.from(document.querySelectorAll('.chip'));

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nodes = NODES.map(n => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, degree: 0 }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = EDGES.map(([a, b]) => ({ a: byId.get(a), b: byId.get(b) }))
    .filter(e => {
      if (!e.a || !e.b) {
        console.warn('Unknown graph edge endpoint:', e.a ? '?' : e.b);
        return false;
      }
      return true;
    });
  edges.forEach(e => { e.a.degree++; e.b.degree++; });

  let width = 0;
  let height = 0;
  let dpr = 1;
  let seeded = false;
  let selected = null;
  let hovered = null;
  let dragNode = null;
  let filter = 'all';
  let query = '';
  let alpha = 0.25;
  let paused = reduceMotion;
  let raf = 0;
  let palette = readPalette();

  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const get = name => cs.getPropertyValue(name).trim();
    return {
      page: get('--accent'), concept: get('--mint'), tool: get('--amber'), risk: get('--coral'),
      ink: get('--ink'), muted: get('--muted'), line: get('--line'), card: get('--card'), paper2: get('--paper-2')
    };
  }

  function colorFor(type) {
    return palette[type] || palette.ink;
  }

  function radius(n) {
    const base = n.type === 'page' ? 8 : 5.5;
    return Math.min(base + n.degree * 0.45, 14);
  }

  // Deterministic random so the layout is stable across reloads.
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function seed() {
    const rng = mulberry32(42);
    const cx = width / 2;
    const cy = height / 2;
    const ordered = nodes.slice().sort((a, b) => (TYPE_RANK[a.type] - TYPE_RANK[b.type]) || a.label.localeCompare(b.label));
    ordered.forEach((n, i) => {
      const ring = n.type === 'page' ? 0.38 : n.type === 'concept' ? 0.66 : n.type === 'tool' ? 0.95 : 1.08;
      const angle = (i / ordered.length) * Math.PI * 2 + (n.type === 'page' ? -0.4 : 0.28);
      const r = Math.min(width, height) * 0.43 * ring;
      n.x = cx + Math.cos(angle) * r + (rng() - 0.5) * 26;
      n.y = cy + Math.sin(angle) * r + (rng() - 0.5) * 26;
      n.vx = 0; n.vy = 0;
    });
  }

  function clampPositions() {
    nodes.forEach(n => {
      const label = n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label;
      ctx.font = n.type === 'page' ? FONT_PAGE : FONT_NODE;
      const padX = Math.min(ctx.measureText(label).width / 2 + 7, width / 2 - 10);
      n.x = Math.max(padX, Math.min(width - padX, n.x));
      n.y = Math.max(26, Math.min(height - 32, n.y));
    });
  }

  function tick(strength) {
    const cx = width / 2;
    const cy = height / 2;

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = 1; dy = 0; d2 = 1; }
        const d = Math.sqrt(d2);
        const rep = 1350 / (d2 + 55);
        const fx = (dx / d) * rep;
        const fy = (dy / d) * rep;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Springs
    for (const e of edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = 92 + ((e.a.type === 'page' || e.b.type === 'page') ? 8 : 0);
      const f = (d - target) * 0.0055;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      e.a.vx += fx; e.a.vy += fy;
      e.b.vx -= fx; e.b.vy -= fy;
    }

    // Gravity, damping, integration
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.0008;
      n.vy += (cy - n.y) * 0.0008;
      n.vx *= 0.88;
      n.vy *= 0.88;
      n.x += n.vx * strength;
      n.y += n.vy * strength;
    }
    clampPositions();
  }

  function prewarm(iterations) {
    for (let i = 0; i < iterations; i++) tick(1);
  }

  function matches(n) {
    const q = query.trim().toLowerCase();
    if (filter !== 'all' && n.type !== filter) return false;
    if (!q) return true;
    return (n.label + ' ' + n.summary + ' ' + n.type).toLowerCase().includes(q);
  }

  function draw() {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);

    const active = selected || hovered;
    const connected = new Set();
    if (active) {
      connected.add(active.id);
      for (const e of edges) {
        if (e.a === active) connected.add(e.b.id);
        if (e.b === active) connected.add(e.a.id);
      }
    }

    // Edges
    ctx.lineWidth = 1;
    for (const e of edges) {
      const relevant = active && (e.a === active || e.b === active);
      const dim = (filter !== 'all' || query) && !(matches(e.a) || matches(e.b));
      ctx.globalAlpha = relevant ? 0.85 : dim ? 0.05 : 0.22;
      ctx.strokeStyle = relevant ? palette.ink : palette.line;
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.stroke();
      if (relevant) drawArrow(e.a, e.b);
    }

    // Nodes
    for (const n of nodes) {
      const isMatch = matches(n);
      const isActive = n === active;
      const isConnected = connected.has(n.id);
      const dim = !isMatch || (active && !isActive && !isConnected);
      ctx.globalAlpha = dim ? 0.12 : 1;

      const r = radius(n);
      if (isActive) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = palette.card;
        ctx.fill();
        ctx.strokeStyle = palette.ink;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(n.type);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = palette.card;
      ctx.stroke();

      if (!dim || isActive) {
        const label = n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label;
        ctx.font = n.type === 'page' ? FONT_PAGE : FONT_NODE;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const tx = n.x;
        const ty = n.y + r + 4;
        ctx.lineWidth = 3;
        ctx.strokeStyle = palette.card;
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = palette.ink;
        ctx.fillText(label, tx, ty);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawArrow(a, b) {
    const t = 0.7;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const size = 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(angle - 0.45), y - size * Math.sin(angle - 0.45));
    ctx.lineTo(x - size * Math.cos(angle + 0.45), y - size * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fillStyle = palette.ink;
    ctx.fill();
  }

  function pointFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function hitTest(p) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (Math.hypot(n.x - p.x, n.y - p.y) <= radius(n) + 7) return n;
    }
    return null;
  }

  function showTooltip(n, p) {
    if (!n) { tooltip.hidden = true; return; }
    tooltip.textContent = n.label + ' · ' + TYPE_LABEL[n.type];
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let x = p.x + 14;
    let y = p.y + 14;
    if (x + tw > width - 8) x = p.x - tw - 14;
    if (y + th > height - 8) y = p.y - th - 14;
    tooltip.style.left = Math.max(8, x) + 'px';
    tooltip.style.top = Math.max(8, y) + 'px';
  }

  function updateInfo(n) {
    if (!n) {
      info.innerHTML = '<p class="eyebrow">Selected node</p><h3>Nothing selected</h3><p class="empty">Click any node to see what it is and where to read more. The legend below maps color to type.</p>';
      return;
    }
    info.textContent = '';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = 'Selected node';
    const title = document.createElement('h3');
    title.textContent = n.label;
    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = TYPE_LABEL[n.type] + ' · ' + n.degree + ' connection' + (n.degree === 1 ? '' : 's');
    const summary = document.createElement('p');
    summary.textContent = n.summary;
    info.append(eyebrow, title, kind, summary);
    if (n.page) {
      const a = document.createElement('a');
      a.href = n.page;
      a.textContent = 'Read more →';
      info.append(a);
    }
  }

  function updateCount() {
    const shown = nodes.filter(matches).length;
    countEl.textContent = `${shown} of ${nodes.length} nodes · ${edges.length} edges`;
  }

  function reheat() {
    if (paused) return;
    alpha = Math.max(alpha, 0.55);
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (paused) { draw(); return; }
    tick(alpha);
    alpha *= 0.987;
    draw();
    if (alpha > 0.018) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = Math.max(320, rect.width);
    height = Math.max(420, rect.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!seeded) {
      seed();
      seeded = true;
    } else {
      clampPositions();
    }
    draw();
  }

  // Pointer interactions
  canvas.addEventListener('pointerdown', ev => {
    const p = pointFromEvent(ev);
    const n = hitTest(p);
    if (n) {
      dragNode = n;
      selected = n;
      updateInfo(n);
      showTooltip(null);
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add('dragging');
      reheat();
      draw();
    } else {
      selected = null;
      updateInfo(null);
      draw();
    }
  });

  canvas.addEventListener('pointermove', ev => {
    const p = pointFromEvent(ev);
    if (dragNode) {
      dragNode.x = p.x;
      dragNode.y = p.y;
      dragNode.vx = 0;
      dragNode.vy = 0;
      reheat();
      draw();
      return;
    }
    const n = hitTest(p);
    hovered = n;
    canvas.style.cursor = n ? 'pointer' : 'grab';
    showTooltip(n, p);
    draw();
  });

  canvas.addEventListener('pointerup', ev => {
    if (dragNode) {
      dragNode = null;
      canvas.classList.remove('dragging');
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      reheat();
    }
  });

  canvas.addEventListener('pointerleave', () => {
    if (!dragNode) {
      hovered = null;
      tooltip.hidden = true;
      draw();
    }
  });

  canvas.addEventListener('dblclick', ev => {
    const n = hitTest(pointFromEvent(ev));
    if (n && n.page) window.location.href = n.page;
  });

  // Controls
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    updateCount();
    draw();
  });

  resetBtn.addEventListener('click', () => {
    seed();
    alpha = 0.8;
    if (paused) {
      prewarm(260);
      draw();
    } else {
      reheat();
    }
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (paused) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      draw();
    } else {
      reheat();
    }
  });

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      filter = chip.dataset.filter || 'all';
      chips.forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
      updateCount();
      draw();
    });
  });

  // Build an accessible list of all nodes.
  const list = document.getElementById('node-list');
  if (list) {
    list.textContent = '';
    nodes.slice().sort((a, b) => (TYPE_RANK[a.type] - TYPE_RANK[b.type]) || a.label.localeCompare(b.label)).forEach(n => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = n.page;
      a.textContent = n.label;
      const span = document.createElement('span');
      span.className = 'small';
      span.textContent = ' · ' + TYPE_LABEL[n.type];
      li.append(a, span);
      list.append(li);
    });
  }

  // Theme changes
  const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onThemeChange = () => { palette = readPalette(); draw(); };
  if (themeQuery.addEventListener) themeQuery.addEventListener('change', onThemeChange);

  // Initialize
  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);

  resize();
  updateCount();
  updateInfo(null);

  if (reduceMotion) {
    prewarm(420);
    alpha = 0.01;
    paused = true;
    pauseBtn.setAttribute('aria-pressed', 'true');
    pauseBtn.textContent = 'Resume';
    draw();
  } else {
    prewarm(320);
    alpha = 0.4;
    draw();
    raf = requestAnimationFrame(frame);
  }
})();
