'use client';

import { FlaskConical, FileSearch, ShieldCheck, Atom, Share2, BrainCircuit } from 'lucide-react';
import styles from './Sidebar.module.css';

const modules = [
  { id: 'formugraph',label: 'Orchestrator',    icon: BrainCircuit,  accent: 'formugraph' },
  { id: 'topology',label: 'Agent Topology',    icon: Share2,  accent: 'formugraph' },
];

export default function Sidebar({ activeModule, onModuleChange }) {
  return (
    <aside className={styles.sidebar}>
      {/* Logo */}
      <div className={styles.logo}>
        {/* Logo Icon removed per feedback */}
        <span className={styles.logoText}>FormuGraph</span>
      </div>

      {/* Divider */}
      <div className={styles.divider} />

      {/* Nav */}
      <nav className={styles.nav}>
        <span className={styles.navSection}>Intelligent Agents</span>
        {modules.map(({ id, label, icon: Icon, accent }) => (
          <button
            key={id}
            className={`${styles.navItem} ${activeModule === id ? styles[`active_${accent}`] : ''}`}
            onClick={() => onModuleChange(id)}
          >
            <Icon size={18} className={styles.navIcon} />
            <span className={styles.navLabel}>{label}</span>
            {activeModule === id && <span className={styles.navDot} />}
          </button>
        ))}
      </nav>

      {/* Footer */}
      <div className={styles.footer}>
        <p className={styles.footerSub}>Orchestrate between structured and unstructured data sets</p>
      </div>
    </aside>
  );
}
