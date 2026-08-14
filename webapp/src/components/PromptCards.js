'use client';

import styles from './PromptCards.module.css';

const modulePrompts = {
  ai: {
    title: 'Ask AI Anything',
    subtitle: 'Natural language queries across all pharma datasets',
    accent: 'cyan',
    prompts: [
      { label: 'FDA Drug Lookup', text: 'Find all FDA approved drug products containing metformin and show their application numbers and sponsors' },
      { label: 'Patent Landscape', text: 'Find 10 recent patent publications related to GLP-1 receptor agonists' },
      { label: 'Molecule Explorer', text: 'Show me 10 molecules from ChEMBL in clinical phase 3 or 4 with their ChEMBL IDs and preferred names' },
      { label: 'Cross-Dataset Join', text: 'Find FDA approved drugs with their corresponding ChEMBL molecule IDs and molecular weights' },
    ],
  },
  patent: {
    title: 'Patent Intelligence',
    subtitle: 'Landscape analysis, assignee trends & filing timelines',
    accent: 'patent',
    prompts: [
      { label: 'Assignee Landscape', text: 'List the top 10 assignees with the most patent publications for diabetes drugs' },
      { label: 'Filing Trends', text: 'Find patents related to mRNA therapeutics filed after 2018 with their titles and filing dates' },
      { label: 'Compound Patents', text: 'Find all patent publications mentioning semaglutide in the title or abstract' },
      { label: 'Expiry Horizon', text: 'Find patents for insulin analogues filed before 2005 that might be expiring soon' },
    ],
  },
  fto: {
    title: 'FTO Analysis',
    subtitle: 'Freedom-to-Operate: discover blocking patents for your molecule',
    accent: 'fto',
    prompts: [
      { label: 'Blocking Patents', text: 'Find patents that may block freedom-to-operate for paracetamol in the US market assigned to major pharma companies' },
      { label: 'Competitor Watch', text: 'Show patent publications from Pfizer or Novartis related to SGLT2 inhibitors' },
      { label: 'Recent Filings', text: 'Find competitor patent filings for antibody-drug conjugates from the last 5 years' },
      { label: 'Generic Entry', text: 'Find patents for ibuprofen where the grant date is before 2000, indicating potential generic entry' },
    ],
  },
  molecule: {
    title: 'Molecule Properties',
    subtitle: 'Physiochemical intelligence from ChEMBL',
    accent: 'molecule',
    prompts: [
      { label: 'Single Molecule', text: 'What are the physicochemical properties of aspirin including molecular weight, LogP, and polar surface area from ChEMBL?' },
      { label: 'Comparison', text: 'Compare the molecular weight, ALogP and PSA of metformin, glipizide, and sitagliptin' },
      { label: 'Lipinski Filters', text: 'Find 20 ChEMBL molecules with molecular weight under 500, ALogP under 5, and in clinical phase 2 or above' },
      { label: 'Drug-Like Score', text: 'Show molecules with therapeutic flag set to 1 and max clinical phase of 4, ordered by molecular weight' },
    ],
  },
};

export default function PromptCards({ module, onPromptSelect }) {
  const config = modulePrompts[module];
  if (!config) return null;

  return (
    <div className={`${styles.wrapper} ${styles[config.accent]}`}>
      <div className={styles.header}>
        <h2 className={styles.title}>{config.title}</h2>
        <p className={styles.subtitle}>{config.subtitle}</p>
      </div>
      <div className={styles.grid}>
        {config.prompts.map((p, i) => (
          <button
            key={i}
            className={styles.card}
            onClick={() => onPromptSelect(p.text)}
          >
            <span className={styles.cardLabel}>{p.label}</span>
            <p className={styles.cardText}>{p.text}</p>
            <span className={styles.cardArrow}>→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
