'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  Position,
} from '@xyflow/react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import styles from './AgentTopology.module.css';

/**
 * Agent topology — a conceptual view, not a wiring diagram.
 *
 * Its job is to explain the four problems this system actually solves:
 *
 *   1. Blending structured and unstructured data   (left column)
 *   2. Multi-agent specialisation                  (agent column)
 *   3. Loop engineering                            (orchestrator)
 *   4. Harnessing an unreliable narrator           (harness -> deliverable)
 *
 * An earlier version drew every agent, data source and edge. That was accurate
 * and unreadable: it answered "what calls what" while leaving "why is it built
 * this way" entirely to the reader. Per-agent wiring now lives in the README.
 */

const PALETTE = {
  structured: { bg: '#f0fdf4', border: '#86efac', text: '#15803d' },
  unstructured: { bg: '#fff7ed', border: '#fdba74', text: '#c2410c' },
  agent: { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8' },
  deterministic: { bg: '#f5f3ff', border: '#c4b5fd', text: '#6d28d9' },
  loop: { bg: '#6366f1', border: '#4f46e5', text: '#ffffff' },
  harness: { bg: '#fef2f2', border: '#fca5a5', text: '#b91c1c' },
  deliverable: { bg: '#ecfeff', border: '#67e8f9', text: '#0e7490' },
};

const base = {
  borderRadius: 10,
  padding: '10px 12px',
  fontFamily: "'Outfit', system-ui, sans-serif",
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'center',
  lineHeight: 1.35,
};

function node(id, kind, label, x, y, opts = {}) {
  const p = PALETTE[kind];
  const width = opts.width ?? 168;
  return {
    id,
    position: { x, y },
    sourcePosition: opts.sourcePosition ?? Position.Right,
    targetPosition: opts.targetPosition ?? Position.Left,
    data: { label, kind },
    width,
    height: opts.height ?? 62,
    style: {
      ...base,
      background: p.bg,
      border: `1.5px solid ${p.border}`,
      color: p.text,
      width,
      ...(opts.style || {}),
    },
  };
}

/** Column caption — names the problem each band solves. */
function caption(id, label, x, y, width = 190) {
  return {
    id,
    position: { x, y },
    width,
    height: 40,
    selectable: false,
    draggable: false,
    connectable: false,
    // Captions are labels, not participants — `captionNode` hides the
    // connection handles React Flow renders on every node by default.
    className: 'captionNode',
    data: { label, kind: 'caption' },
    style: {
      width,
      background: 'transparent',
      border: 'none',
      boxShadow: 'none',
      fontFamily: "'Outfit', system-ui, sans-serif",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.4px',
      textTransform: 'uppercase',
      color: '#94a3b8',
      textAlign: 'center',
      lineHeight: 1.35,
    },
  };
}

// Content is held inside ~980x460 so it renders at zoom 1 in the canvas.
const C = { data: 0, agents: 205, loop: 410, harness: 615, out: 812 };
const R = { a: 20, b: 118, c: 216, d: 314, cap: 400 };

const initialNodes = [
  // ── 1. blending structured + unstructured ──
  node(
    'structured',
    'structured',
    '📊 Structured\nOrange Book · ChEMBL\nqueryable fields → S1',
    C.data,
    R.b,
    { width: 172 },
  ),
  node(
    'unstructured',
    'unstructured',
    '📄 Unstructured\npatent claims · label prose\nfull text → U1',
    C.data,
    R.c,
    { width: 172 },
  ),

  // ── 2. multi-agent specialisation ──
  node('regulatory', 'agent', '⚖️ Regulatory\norange_book · rld_profile', C.agents, R.a),
  node('chemistry', 'agent', '⚗️ Chemistry\nphyschem · structured_query', C.agents, R.b),
  node('patent', 'agent', '📚 Patent\npatent_fto · document_reason', C.agents, R.c),
  node('math', 'deterministic', '🔢 Arithmetic\ndeterministic · no LLM', C.agents, R.d),

  // ── 3. loop engineering ──
  node(
    'loop',
    'loop',
    '🧠 Orchestrator loop\nparallel dispatch → fuse → retrieve\n≤ 8 turns · cached prefix',
    C.loop,
    R.b,
    { width: 180, height: 76, style: { boxShadow: '0 4px 18px rgba(99,102,241,0.35)' } },
  ),
  node(
    'envelope',
    'loop',
    '📦 Envelope\nschema-validated\n≤ 2 repair turns',
    C.loop,
    R.c,
    { width: 180, style: { boxShadow: '0 4px 14px rgba(99,102,241,0.2)' } },
  ),

  // ── 4. harnessing ──
  node(
    'harness',
    'harness',
    '🛡️ Harness\n10 rules, re-checked against\nthe recorded tool outputs',
    C.harness,
    R.b,
    { width: 176, height: 76 },
  ),
  node(
    'severity',
    'harness',
    'blocking → phase 6 FAIL\nadvisory → recorded only',
    C.harness,
    R.c,
    { width: 176 },
  ),

  // ── deliverable ──
  node('corridors', 'deliverable', '📐 Design corridors\nwhere design freedom exists', C.out, R.a + 40, {
    width: 168,
  }),
  node('spec', 'deliverable', '📋 RLD specification\nwhere Q1/Q2 fixes it', C.out, R.c, { width: 168 }),

  // ── captions: the problem each band solves ──
  caption('cap1', 'Blending structured\n+ unstructured', C.data - 8, R.cap),
  caption('cap2', 'Multi-agent\nspecialisation', C.agents - 12, R.cap),
  caption('cap3', 'Loop\nengineering', C.loop - 4, R.cap),
  caption('cap4', 'Harnessing', C.harness - 8, R.cap),
  caption('cap5', 'Deliverable fits\nthe pathway', C.out - 12, R.cap),
];

/** Content bounds, derived from the nodes rather than measured. */
const CONTENT = initialNodes.reduce(
  (acc, n) => ({
    minX: Math.min(acc.minX, n.position.x),
    minY: Math.min(acc.minY, n.position.y),
    maxX: Math.max(acc.maxX, n.position.x + n.width),
    maxY: Math.max(acc.maxY, n.position.y + n.height),
  }),
  { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
);

const feed = {
  markerEnd: { type: MarkerType.ArrowClosed },
  style: { stroke: '#94a3b8', strokeWidth: 2 },
  labelStyle: { fontSize: 10, fontWeight: 700, fill: '#475569' },
  labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.95 },
  labelBgPadding: [4, 2],
  labelBgBorderRadius: 4,
};

const dispatch = {
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed },
  style: { stroke: '#a5b4fc', strokeWidth: 2 },
  labelStyle: { fontSize: 10, fontWeight: 700, fill: '#4338ca' },
  labelBgStyle: { fill: '#eef2ff', fillOpacity: 0.95 },
  labelBgPadding: [4, 2],
  labelBgBorderRadius: 4,
};

// The return leg — this is what makes it a loop rather than a pipeline.
const loopBack = {
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed },
  style: { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '5 4' },
  labelStyle: { fontSize: 10, fontWeight: 700, fill: '#b45309' },
  labelBgStyle: { fill: '#fffbeb', fillOpacity: 0.95 },
  labelBgPadding: [4, 2],
  labelBgBorderRadius: 4,
};

const initialEdges = [
  { id: 'd1', source: 'structured', target: 'regulatory', ...feed },
  { id: 'd2', source: 'structured', target: 'chemistry', ...feed },
  { id: 'd3', source: 'structured', target: 'patent', label: 'discovery', ...feed },
  { id: 'd4', source: 'unstructured', target: 'patent', label: 'per document', ...feed },

  { id: 'a1', source: 'regulatory', target: 'loop', ...dispatch },
  { id: 'a2', source: 'chemistry', target: 'loop', ...dispatch },
  { id: 'a3', source: 'patent', target: 'loop', ...dispatch },
  { id: 'a4', source: 'math', target: 'loop', ...dispatch },

  {
    id: 'loopback',
    source: 'loop',
    target: 'patent',
    label: 'results steer the next turn',
    ...loopBack,
  },

  { id: 'e1', source: 'loop', target: 'envelope', label: 'emit', ...feed },
  { id: 'e2', source: 'envelope', target: 'harness', ...feed },
  { id: 'e3', source: 'harness', target: 'severity', ...feed },
  { id: 'o1', source: 'harness', target: 'corridors', label: 'design freedom', ...feed },
  { id: 'o2', source: 'severity', target: 'spec', label: 'Q1/Q2 applies', ...feed },
];

const LEGEND = [
  { kind: 'structured', label: 'Structured data (S1)' },
  { kind: 'unstructured', label: 'Unstructured text (U1)' },
  { kind: 'agent', label: 'Specialist agent' },
  { kind: 'deterministic', label: 'Deterministic, no LLM' },
  { kind: 'loop', label: 'Orchestration loop' },
  { kind: 'harness', label: 'Harness' },
  { kind: 'deliverable', label: 'Deliverable' },
];

const PROBLEMS = [
  {
    title: 'Blending structured + unstructured',
    body:
      'Structured sources answer "what is listed" — Orange Book patents and expiry dates, ChEMBL ' +
      'properties. Unstructured text answers "what is actually claimed" — the patent claim itself, ' +
      'the label’s composition prose. Neither alone is an FTO answer. Every value carries where it ' +
      'came from, and precedence runs S1 > S2 > U1 > U2 > I.',
  },
  {
    title: 'Multi-agent specialisation',
    body:
      'Seven agents, each owning one domain and one retrieval path, so a failure stays contained and ' +
      'attributable. When the patent landscape sweep exceeds its cost ceiling, the Orange Book seeds ' +
      'still classify and the run continues degraded rather than dying.',
  },
  {
    title: 'Loop engineering',
    body:
      'Independent calls go out in one turn; dependent ones wait. The budget is 8 turns, the system ' +
      'prompt is a cached prefix, and a malformed envelope gets at most 2 repair turns before the run ' +
      'returns what it has. The loop is bounded in turns, tokens and BigQuery bytes.',
  },
  {
    title: 'Harnessing',
    body:
      'The model does not grade its own evidence. Ten rules re-check every claim against the recorded ' +
      'tool outputs: a U1 citation must name a document that was actually retrieved, a corridor can ' +
      'never be S1, expired patents cannot block, and a failed phase fails the phases consuming it. ' +
      'Blocking findings fail verification; advisory ones are recorded without crying wolf.',
  },
];

export default function AgentTopology() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [notesOpen, setNotesOpen] = useState(false);
  const flowRef = useRef(null);
  const canvasRef = useRef(null);

  const onConnect = useCallback((params) => setEdges((eds) => addEdge(params, eds)), [setEdges]);
  const nodeColor = useMemo(() => (n) => PALETTE[n.data?.kind]?.border || '#e2e8f0', []);

  const fitGraph = useCallback((size) => {
    const instance = flowRef.current;
    const el = canvasRef.current;
    if (!instance || !el) return;
    const rect = el.getBoundingClientRect();
    const width = size?.width || rect.width;
    const height = size?.height || rect.height;
    if (!width || !height) return;

    const margin = 28;
    const contentW = CONTENT.maxX - CONTENT.minX;
    const contentH = CONTENT.maxY - CONTENT.minY;
    const zoom = Math.min((width - margin * 2) / contentW, (height - margin * 2) / contentH, 1);
    instance.setViewport(
      {
        zoom,
        x: (width - contentW * zoom) / 2 - CONTENT.minX * zoom,
        y: (height - contentH * zoom) / 2 - CONTENT.minY * zoom,
      },
      { duration: 200 },
    );
  }, []);

  // React Flow mounts a frame before the flex row resolves, so `onInit` fires
  // against a 0x0 box and a fit attempted then silently bails. Retry on frames
  // until the box is real, then hand off to a ResizeObserver.
  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let attempts = 0;

    const tryFit = () => {
      if (cancelled) return;
      const width = canvasRef.current?.getBoundingClientRect().width ?? 0;
      if (width > 0 && flowRef.current) {
        fitGraph();
        return;
      }
      if (attempts < 90) {
        attempts += 1;
        frame = requestAnimationFrame(tryFit);
      }
    };
    tryFit();

    let observer;
    if (canvasRef.current && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (!width || !height) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => fitGraph({ width, height }));
      });
      observer.observe(canvasRef.current);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [fitGraph]);

  return (
    <div className={styles.topologyContainer}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div>
            <h2 className={styles.title}>Agent Topology</h2>
            <p className={styles.subtitle}>
              How structured records and unstructured text become one verified envelope — and what
              each band of the pipeline exists to solve.
            </p>
          </div>
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setNotesOpen((o) => !o)}
            aria-expanded={notesOpen}
          >
            {notesOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            {notesOpen ? 'Hide notes' : 'Show notes'}
          </button>
        </div>

        <div className={styles.legend}>
          {LEGEND.map(({ kind, label }) => (
            <span key={kind} className={styles.legendItem}>
              <span
                className={styles.legendSwatch}
                style={{ background: PALETTE[kind].bg, borderColor: PALETTE[kind].border }}
              />
              {label}
            </span>
          ))}
        </div>
      </header>

      <div className={styles.flowWrapper}>
        <div className={styles.canvas} ref={canvasRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={(instance) => {
              flowRef.current = instance;
              fitGraph();
            }}
            minZoom={0.3}
            maxZoom={1.8}
            attributionPosition="bottom-right"
          >
            <Controls onFitView={fitGraph} />
            <MiniMap
              nodeColor={nodeColor}
              pannable
              zoomable
              style={{
                width: 140,
                height: 86,
                background: 'rgba(255,255,255,0.92)',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
              }}
            />
            <Background variant="dots" gap={16} size={1} color="#cbd5e1" />
          </ReactFlow>
        </div>

        {notesOpen && (
          <aside className={styles.notes}>
            {PROBLEMS.map((p) => (
              <section key={p.title}>
                <h3 className={styles.notesTitle}>{p.title}</h3>
                <p className={styles.notesBody}>{p.body}</p>
              </section>
            ))}

            <h3 className={styles.notesTitle}>Why the retrieval splits</h3>
            <p className={styles.notesBody}>
              <code>patents.publications</code> is 2.81 TiB with no partitioning or clustering, so a{' '}
              <code>WHERE</code> prunes nothing — claims for a single patent cost ~117 GiB. BigQuery
              therefore does <strong>discovery on titles</strong> (~19 GiB) and full text is fetched{' '}
              <strong>per document</strong> over HTTP. The RLD composition comes from the FDA label,
              not BigQuery.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}
