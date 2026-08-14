'use client';

import React, { useCallback } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import styles from './SemanticGraph.module.css';

const TableNode = ({ header, columns, accentClass }) => (
  <div className={`${styles.tableCard} ${styles[accentClass]}`}>
    <div className={styles.tableHeader}>
      <span className={styles.tableHeaderDot} />
      {header}
    </div>
    <div className={styles.tableCols}>
      {columns.map(({ name, isKey }) => (
        <div key={name} className={`${styles.tableCol} ${isKey ? styles.keyCol : ''}`}>
          {isKey && <span className={styles.keyIcon}>◆</span>}
          {name}
        </div>
      ))}
    </div>
  </div>
);

const initialNodes = [
  // ─── FDA Group ───
  {
    id: 'g-fda', type: 'group', position: { x: 40, y: 40 },
    data: { label: 'FDA Drug' },
    style: { width: 310, height: 330 },
    className: styles.group,
  },
  {
    id: 'drug_product', parentId: 'g-fda', extent: 'parent',
    position: { x: 20, y: 55 }, className: styles.node,
    data: { label: <TableNode header="drug_product" accentClass="accentBlue" columns={[
      { name: 'appl_no' }, { name: 'drug_name' },
      { name: 'active_ingredient', isKey: true }, { name: 'form' }, { name: 'strength' },
    ]} /> },
  },
  {
    id: 'application', parentId: 'g-fda', extent: 'parent',
    position: { x: 20, y: 220 }, className: styles.node,
    data: { label: <TableNode header="application" accentClass="accentBlue" columns={[
      { name: 'appl_no', isKey: true }, { name: 'appl_type' }, { name: 'sponsor_name' },
    ]} /> },
  },

  // ─── ChEMBL Group ───
  {
    id: 'g-chembl', type: 'group', position: { x: 440, y: 40 },
    data: { label: 'ChEMBL' },
    style: { width: 310, height: 330 },
    className: styles.group,
  },
  {
    id: 'molecule_dictionary', parentId: 'g-chembl', extent: 'parent',
    position: { x: 20, y: 55 }, className: styles.node,
    data: { label: <TableNode header="molecule_dictionary" accentClass="accentPurple" columns={[
      { name: 'molregno', isKey: true }, { name: 'pref_name', isKey: true },
      { name: 'chembl_id' }, { name: 'max_phase' }, { name: 'therapeutic_flag' },
    ]} /> },
  },
  {
    id: 'compound_properties', parentId: 'g-chembl', extent: 'parent',
    position: { x: 20, y: 220 }, className: styles.node,
    data: { label: <TableNode header="compound_properties" accentClass="accentPurple" columns={[
      { name: 'molregno', isKey: true }, { name: 'mw_freebase' },
      { name: 'alogp' }, { name: 'psa' }, { name: 'rtb' },
    ]} /> },
  },

  // ─── Patents Group ───
  {
    id: 'g-patents', type: 'group', position: { x: 240, y: 430 },
    data: { label: 'Global Patents' },
    style: { width: 310, height: 230 },
    className: styles.group,
  },
  {
    id: 'publications', parentId: 'g-patents', extent: 'parent',
    position: { x: 20, y: 55 }, className: styles.node,
    data: { label: <TableNode header="publications" accentClass="accentOrange" columns={[
      { name: 'publication_number', isKey: true }, { name: 'application_number' },
      { name: 'title_localized[0].text' }, { name: 'assignee' },
      { name: 'filing_date' }, { name: 'grant_date' },
    ]} /> },
  },
];

const edgeBase = { markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 } };

const initialEdges = [
  {
    ...edgeBase, id: 'e1', source: 'drug_product', target: 'molecule_dictionary',
    label: 'active_ingredient = pref_name', animated: true,
    style: { ...edgeBase.style, stroke: '#a78bfa' },
    markerEnd: { ...edgeBase.markerEnd, color: '#a78bfa' },
    labelStyle: { fill: '#a78bfa', fontSize: 11, fontWeight: 600 },
    labelBgStyle: { fill: '#0d1117', fillOpacity: 0.8 },
  },
  {
    ...edgeBase, id: 'e2', source: 'drug_product', target: 'application',
    label: 'appl_no',
    style: { ...edgeBase.style, stroke: '#38bdf8', strokeDasharray: '5 4' },
    markerEnd: { ...edgeBase.markerEnd, color: '#38bdf8' },
    labelStyle: { fill: '#38bdf8', fontSize: 11 },
    labelBgStyle: { fill: '#0d1117', fillOpacity: 0.8 },
  },
  {
    ...edgeBase, id: 'e3', source: 'molecule_dictionary', target: 'compound_properties',
    label: 'molregno',
    style: { ...edgeBase.style, stroke: '#c084fc', strokeDasharray: '5 4' },
    markerEnd: { ...edgeBase.markerEnd, color: '#c084fc' },
    labelStyle: { fill: '#c084fc', fontSize: 11 },
    labelBgStyle: { fill: '#0d1117', fillOpacity: 0.8 },
  },
  {
    ...edgeBase, id: 'e4', source: 'molecule_dictionary', target: 'publications',
    label: 'pref_name → title/abstract', animated: true,
    style: { ...edgeBase.style, stroke: '#f97316' },
    markerEnd: { ...edgeBase.markerEnd, color: '#f97316' },
    labelStyle: { fill: '#f97316', fontSize: 11, fontWeight: 600 },
    labelBgStyle: { fill: '#0d1117', fillOpacity: 0.8 },
  },
];

export default function SemanticGraph() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const onConnect = useCallback(p => setEdges(e => addEdge(p, e)), [setEdges]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView fitViewOptions={{ padding: 0.2 }}
        minZoom={0.4} maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(255,255,255,0.04)" />
        <Controls className={styles.controls} />
        <MiniMap
          nodeColor={n => n.type === 'group' ? 'rgba(255,255,255,0.03)' : 'rgba(56,189,248,0.4)'}
          maskColor="rgba(8,12,20,0.7)"
          style={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12 }}
        />
        {/* Legend */}
        <div className={styles.legend}>
          <span className={styles.legendTitle}>Join Relationships</span>
          <div className={styles.legendItem}><span className={styles.dot} style={{ background: '#a78bfa' }} /> FDA → ChEMBL (active ingredient)</div>
          <div className={styles.legendItem}><span className={styles.dot} style={{ background: '#f97316' }} /> ChEMBL → Patents (compound name)</div>
          <div className={styles.legendItem}><span className={styles.dot} style={{ background: '#38bdf8', opacity: 0.6 }} /> Internal FK joins</div>
        </div>
      </ReactFlow>
    </div>
  );
}
