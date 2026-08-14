'use client';

import { useState, useEffect, Component } from 'react';
import {
  Loader2, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle2, XCircle, AlertCircle, FileText,
  Beaker, Shield, Zap, List, HelpCircle, BookOpen, Download, Activity
} from 'lucide-react';
import styles from './FormuGraph.module.css';

const MARKETS = ['US', 'EP', 'WO', 'IN', 'JP', 'CN'];
const DOSAGE_FORMS = ['Tablet', 'Capsule', 'Oral Solution', 'Suspension', 'Injection', 'Patch', 'Cream', 'Other'];
const NUM_AGENTS = 5;

const EXAMPLE_INPUTS = [
  { molecule: 'Metformin', dosageForm: 'Tablet', strength: '500mg', targetMarkets: ['US', 'EP'], objective: 'Generic development and design-around existing formulation patents' },
  { molecule: 'Semaglutide', dosageForm: 'Injection', strength: '1mg/mL', targetMarkets: ['US', 'EP', 'WO'], objective: 'Generic FTO analysis (ANDA/505(b)(2) pathway)' },
  { molecule: 'Paracetamol', dosageForm: 'Tablet', strength: '500mg', targetMarkets: ['US', 'IN'], objective: 'Extended release formulation development' },
];

// Status configs keyed to the current envelope schema values
const STATUS_CONFIG = {
  GO:                { icon: CheckCircle2, color: '#10b981', label: 'GO' },
  NO_GO:             { icon: XCircle,      color: '#f87171', label: 'NO GO' },
  REVIEW:            { icon: AlertTriangle, color: '#f59e0b', label: 'REVIEW' },
  ABORTED_NO_DATA:   { icon: AlertCircle,  color: '#94a3b8', label: 'ABORTED' },
  // legacy/fallback keys
  blocked:           { icon: XCircle,      color: '#f87171', label: 'Blocked' },
  open:              { icon: CheckCircle2, color: '#10b981', label: 'Open' },
  notFound:          { icon: AlertCircle,  color: '#f59e0b', label: 'Not Found' },
  tension:           { icon: AlertTriangle, color: '#f97316', label: 'Tension' },
};

const PHASE_LABELS = [
  'Phase 0: Molecule Normalization',
  'Phase 1: Structured Data Sweep (FDA, ChEMBL)',
  'Phase 2: Patent & FTO Analysis',
  'Phase 3: Physicochemical Profile',
  'Phase 4: Cross-Domain Fusion',
  'Phase 5: Constraint Envelope Emission',
  'Phase 6: Self-Verification',
];

// A run costs 4-5 minutes and real money, so the two ways it used to vanish
// are both handled here rather than left to chance:
//
//  - a render throw anywhere in the envelope tree unmounted the whole page and
//    left a blank panel with the result still sitting in memory, unreachable.
//    ResultErrorBoundary keeps the raw JSON reachable instead.
//  - all run state lived in useState alone, so a Fast Refresh, a reload or a
//    stray navigation discarded a completed run with no way back. Results are
//    now mirrored into sessionStorage and restored on mount.
const STORAGE_KEY = 'formugraph:last-run';

class ResultErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[FormuGraph] envelope render failed', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={styles.rawTextCard}>
        <div className={styles.rawTextHeader}>
          <AlertTriangle size={16} />
          <span>This envelope could not be rendered</span>
        </div>
        <p className={styles.muted}>
          {this.state.error.message} — the run itself completed; the raw result is below and
          the Download JSON button still works.
        </p>
        <pre className={styles.rawTextBody}>
          {JSON.stringify(this.props.result, null, 2)}
        </pre>
      </div>
    );
  }
}

/** ms -> "4m 40s" / "38s". */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

// Measured on a full Metformin/Tablet run: 280 s end to end. Used only to draw
// a progress bar and to say when a run is running long — never to abort one.
const TYPICAL_RUN_MS = 280_000;

// Backstop only — see the note at the fetch call. Deliberately far above both
// the typical run and the server's own ceiling.
const CLIENT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Live elapsed time for the running analysis.
 *
 * Without this the panel showed an unchanging spinner for four and a half
 * minutes, which is indistinguishable from a hung request — the single biggest
 * reason a working run looked broken.
 */
function RunTimer({ startedAt, compact = false }) {
  // Seeded at mount and advanced only by the interval. Callers pass
  // key={startedAt} so a new run mounts a fresh timer rather than needing a
  // synchronous reset inside the effect.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!startedAt) return null;
  const elapsed = Math.max(0, now - startedAt);
  const pct = Math.min(100, (elapsed / TYPICAL_RUN_MS) * 100);
  const overdue = elapsed > TYPICAL_RUN_MS * 1.5;

  if (compact) {
    return <span className={styles.timerInline}>{formatDuration(elapsed)}</span>;
  }

  return (
    <div className={styles.timerBlock}>
      <div className={styles.timerRow}>
        <span className={overdue ? styles.timerValueWarn : styles.timerValue}>
          {formatDuration(elapsed)}
        </span>
        <span className={styles.timerNote}>
          {overdue ? 'longer than usual — still running' : `typically ~${formatDuration(TYPICAL_RUN_MS)}`}
        </span>
      </div>
      <div className={styles.progressTrack}>
        <div
          className={overdue ? styles.progressFillWarn : styles.progressFill}
          style={{ width: `${overdue ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Shared Sub-components ───

function Collapsible({ title, icon: Icon, color, children, defaultOpen = false, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.collapsible}>
      <button className={styles.collapsibleHeader} onClick={() => setOpen(o => !o)} style={{ '--accent': color }}>
        <div className={styles.collapsibleTitle}>
          {Icon && <Icon size={16} style={{ color }} />}
          <span>{title}</span>
          {badge !== undefined && <span className={styles.badge} style={{ background: color + '22', color }}>{badge}</span>}
        </div>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && <div className={styles.collapsibleBody}>{children}</div>}
    </div>
  );
}

function EvidenceTag({ cls }) {
  const colors = { S1: '#10b981', S2: '#38bdf8', U1: '#a78bfa', U2: '#f59e0b', I: '#f87171' };
  const c = colors[cls] || '#888';
  return <span className={styles.evidenceTag} style={{ background: c + '22', color: c }}>{cls || '?'}</span>;
}

function PhaseStatusBadge({ status }) {
  const ok = status === 'PASS';
  return (
    <span className={ok ? styles.phasePass : styles.phaseFail}>
      {ok ? '✓ PASS' : '✗ FAIL'}
    </span>
  );
}

// ─── Design Corridors — aligned to actual envelope schema ───
function CorridorCard({ corridor }) {
  // New schema: parameter, lowerBound, upperBound, unit, zoneType, bindingConstraint, evidenceClass, sourceRefs
  // Legacy schema: corridor, status, evidenceClass, blockingRefs, rationale
  const isNewSchema = 'parameter' in corridor;
  const name = isNewSchema ? corridor.parameter : (corridor.corridor || '—');
  const zoneType = isNewSchema ? corridor.zoneType : corridor.status;
  const isExcluded = zoneType === 'EXCLUDED' || zoneType === 'blocked' || zoneType === 'NO_GO';
  const statusColor = isExcluded ? '#f87171' : '#10b981';
  const StatusIcon = isExcluded ? XCircle : CheckCircle2;
  const refs = isNewSchema ? (corridor.sourceRefs || []) : (corridor.blockingRefs || []);

  return (
    <div className={styles.corridorCard} style={{ '--status-color': statusColor }}>
      <div className={styles.corridorHeader}>
        <StatusIcon size={16} style={{ color: statusColor, flexShrink: 0 }} />
        <strong className={styles.corridorName}>{name}</strong>
        <span className={styles.corridorStatus} style={{ color: statusColor }}>
          {isNewSchema ? zoneType : (STATUS_CONFIG[zoneType]?.label || zoneType)}
        </span>
        <EvidenceTag cls={corridor.evidenceClass} />
      </div>

      {isNewSchema && (corridor.lowerBound != null || corridor.upperBound != null) && (
        <div className={styles.corridorBounds}>
          <span className={styles.boundLabel}>Range:</span>
          <code className={styles.boundValue}>
            {corridor.lowerBound ?? '?'} – {corridor.upperBound ?? '?'} {corridor.unit}
          </code>
          {corridor.bindingConstraint && (
            <span className={styles.bindingRef}>{corridor.bindingConstraint}</span>
          )}
        </div>
      )}

      {!isNewSchema && corridor.rationale && (
        <p className={styles.corridorRationale}>{corridor.rationale}</p>
      )}

      {corridor.rldMatched !== undefined && (
        <p className={styles.corridorRationale}>
          <strong>Q1/Q2:</strong>{' '}
          {corridor.rldMatched === true
            ? 'Reproduces the RLD composition — permitted under 505(j).'
            : corridor.rldMatched === false
              ? 'Deviates from the RLD — requires 505(b)(2).'
              : 'Sameness not stated.'}
        </p>
      )}
      {corridor.pathwayNote && <p className={styles.corridorRationale}>{corridor.pathwayNote}</p>}
      {corridor.pathwayConflict && (
        <p className={styles.traceErrorMsg}>{corridor.pathwayConflict}</p>
      )}
      {corridor.notes && <p className={styles.corridorRationale}>{corridor.notes}</p>}

      {refs.length > 0 && (
        <div className={styles.corridorRefs}>
          {refs.map((r, i) => <code key={i} className={styles.ref}>{r}</code>)}
        </div>
      )}
    </div>
  );
}

// ─── FTO Risk Map — aligned to actual flat envelope schema ───
function FTORiskMapCard({ ftoRiskMap }) {
  // New schema: { coreStructure: { risk, sourceRefs }, polymorph: {...}, formulation: {...} }
  // Old schema: { layers: { coreStructure: [...patents] } }
  const isNewSchema = !ftoRiskMap.layers;

  if (!isNewSchema) {
    // Legacy layer-based rendering
    const totalCount = Object.values(ftoRiskMap.layers || {}).flat().length;
    return (
      <Collapsible title="FTO Risk Map" icon={Shield} color="#f97316" badge={totalCount}>
        {Object.entries(ftoRiskMap.layers || {}).map(([layer, patents]) => (
          Array.isArray(patents) && patents.length > 0 && (
            <Collapsible key={layer} title={layer} color="#f97316" badge={patents.length}>
              {patents.map((p, i) => <PatentCard key={i} patent={p} />)}
            </Collapsible>
          )
        ))}
        <CoverageAttestation attest={ftoRiskMap.coverageAttestation} />
      </Collapsible>
    );
  }

  // New flat-risk rendering — all six taxonomy layers. Rendering only the
  // first three silently dropped processSynthesis, methodOfUse and combination
  // from the UI even though the envelope carried them.
  const RISK_LAYERS = [
    'coreStructure', 'polymorph', 'formulation',
    'processSynthesis', 'methodOfUse', 'combination',
  ];
  const LAYER_LABELS = {
    coreStructure: 'Core Structure',
    polymorph: 'Polymorph',
    formulation: 'Formulation',
    processSynthesis: 'Process / Synthesis',
    methodOfUse: 'Method of Use',
    combination: 'Combination',
  };
  const RISK_COLORS = { HIGH: '#f87171', MEDIUM: '#f59e0b', LOW: '#10b981', UNKNOWN: '#94a3b8' };

  const present = RISK_LAYERS.filter(l => ftoRiskMap[l]);

  return (
    <Collapsible title="FTO Risk Map" icon={Shield} color="#f97316" badge={present.length}>
      <div className={styles.riskSummaryGrid}>
        {present.map(layer => {
          const entry = ftoRiskMap[layer];
          const risk = normalizeRisk(entry.risk);
          const color = RISK_COLORS[risk];
          return (
            <div key={layer} className={styles.riskSummaryCell} style={{ borderLeftColor: color }}>
              <div className={styles.riskCellHeader}>
                <span className={styles.riskLayerName}>{LAYER_LABELS[layer] || layer}</span>
                <span className={styles.riskLevel} style={{ color, background: color + '18' }}>{risk}</span>
              </div>
              {entry.riskQualifier && (
                <p className={styles.muted}>{entry.riskQualifier}</p>
              )}
              {entry.notes && <p className={styles.patentRationale}>{entry.notes}</p>}
              {entry.sourceRefs?.length > 0 && (
                <div className={styles.corridorRefs}>
                  {entry.sourceRefs.map((r, i) => <code key={i} className={styles.ref}>{r}</code>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <CoverageAttestation attest={ftoRiskMap.coverageAttestation} />
    </Collapsible>
  );
}

// Accepts a bare level or a conditional string like
// "LOW (for ANDA 505(j)); HIGH (for 505(b)(2))" and reports the worst level
// mentioned, so a conditional risk never renders as UNKNOWN grey.
function normalizeRisk(value) {
  const upper = String(value || '').toUpperCase();
  if (/\bHIGH\b/.test(upper)) return 'HIGH';
  if (/\bMEDIUM\b/.test(upper)) return 'MEDIUM';
  if (/\bLOW\b/.test(upper)) return 'LOW';
  return 'UNKNOWN';
}

function PatentCard({ patent: p }) {
  return (
    <div className={styles.patentCard}>
      <div className={styles.patentHeader}>
        <code className={styles.patentId}>{p.patentId}</code>
        <span className={`${styles.riskBadge} ${styles['risk_' + (p.riskLevel || '').toLowerCase()]}`}>{p.riskLevel}</span>
        <span className={styles.muted}>{p.country} · Granted {p.grantDate}</span>
      </div>
      <p className={styles.patentTitle}>{p.title}</p>
      <p className={styles.patentRationale}>{p.rationale}</p>
      <p className={styles.patentAssignee}>{p.assignee}</p>
      {p.note && <p className={styles.patentNote}>{p.note}</p>}
    </div>
  );
}

function CoverageAttestation({ attest }) {
  if (!attest) return null;
  return (
    <div className={styles.attestation}>
      <strong>Coverage:</strong> Searched {attest.jurisdictionsSearched?.join(', ') || '—'} as of{' '}
      {attest.asOfDate ? new Date(attest.asOfDate).toLocaleDateString() : '—'}.{' '}
      {attest.patentsFound} patents found. {attest.note}
    </div>
  );
}

// ─── DOE Constraints Table — aligned to actual envelope schema ───
function DOETable({ constraints }) {
  if (!constraints?.length) return <p className={styles.muted}>No constraints emitted.</p>;
  // Schema: { type, description, evidenceClass, sourceRefs }
  const isNewSchema = 'description' in (constraints[0] || {});

  if (isNewSchema) {
    return (
      <div className={styles.tableWrap}>
        <table className={styles.doeTable}>
          <thead>
            <tr>
              <th>Type</th><th>Description</th><th>Class</th><th>Source Refs</th>
            </tr>
          </thead>
          <tbody>
            {constraints.map((c, i) => (
              <tr key={i} className={c.type === 'EXCLUSION' ? styles.hardRow : ''}>
                <td>
                  <span className={c.type === 'EXCLUSION' ? styles.hardBadge : styles.softBadge}>
                    {c.type}
                  </span>
                </td>
                <td className={styles.doeDesc}>{c.description}</td>
                <td><EvidenceTag cls={c.evidenceClass} /></td>
                <td className={styles.propRef}>{(c.sourceRefs || []).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Legacy table
  return (
    <div className={styles.tableWrap}>
      <table className={styles.doeTable}>
        <thead>
          <tr>
            <th>Parameter</th><th>Bound</th><th>Value</th><th>Unit</th><th>Class</th><th>Hardness</th><th>SourceRef</th>
          </tr>
        </thead>
        <tbody>
          {constraints.map((c, i) => (
            <tr key={i} className={c.hardness === 'hard' ? styles.hardRow : ''}>
              <td><strong>{c.parameter}</strong></td>
              <td><code>{c.bound}</code></td>
              <td>{c.value ?? 'null'}</td>
              <td>{c.unit}</td>
              <td><EvidenceTag cls={c.evidenceClass} /></td>
              <td><span className={c.hardness === 'hard' ? styles.hardBadge : styles.softBadge}>{c.hardness}</span></td>
              <td className={styles.propRef}>{c.sourceRef}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Verification Panel ───
function VerificationPanel({ verification }) {
  if (!verification) return null;

  // New schema: phase-keyed objects
  const PHASE_KEYS = [
    'phase0_normalize', 'phase1_fto', 'phase2_physchem',
    'phase3_crossDomainFusion', 'phase4_envelopeAdaptation',
    'phase5_emit', 'phase6_selfVerify'
  ];
  const PHASE_NAMES = {
    phase0_normalize: 'Phase 0: Normalize',
    phase1_fto: 'Phase 1: FTO',
    phase2_physchem: 'Phase 2: Physchem',
    phase3_crossDomainFusion: 'Phase 3: Cross-Domain Fusion',
    phase4_envelopeAdaptation: 'Phase 4: Envelope Adaptation',
    phase5_emit: 'Phase 5: Emit',
    phase6_selfVerify: 'Phase 6: Self-Verify',
  };

  const isNewSchema = PHASE_KEYS.some(k => k in verification);

  if (!isNewSchema) {
    // Legacy: checksFailed / selfAssertedConfidence
    const failed = verification.checksFailed || [];
    return (
      <div className={`${styles.verifyBanner} ${failed.length > 0 ? styles.verifyFail : styles.verifyPass}`}>
        {failed.length > 0
          ? <><XCircle size={16} /> {failed.length} check(s) failed — confidence {((verification.selfAssertedConfidence || 0) * 100).toFixed(0)}%</>
          : <><CheckCircle2 size={16} /> All checks passed · confidence {((verification.selfAssertedConfidence || 0) * 100).toFixed(0)}%</>
        }
      </div>
    );
  }

  const failedPhases = PHASE_KEYS.filter(k => verification[k]?.status === 'FAIL');
  const allPass = failedPhases.length === 0;

  return (
    <>
      <div className={`${styles.verifyBanner} ${allPass ? styles.verifyPass : styles.verifyFail}`}>
        {allPass
          ? <><CheckCircle2 size={16} /> All {PHASE_KEYS.length} phase checks passed</>
          : <><XCircle size={16} /> {failedPhases.length} phase(s) failed verification</>
        }
      </div>
      {!allPass && (
        <div className={styles.verifyDetails}>
          {PHASE_KEYS.map(k => {
            const phase = verification[k];
            if (!phase) return null;
            const conflicts = phase.conflicts || [];
            return (
              <div key={k} className={styles.verifyPhaseRow}>
                <div className={styles.verifyPhaseHeader}>
                  <PhaseStatusBadge status={phase.status} />
                  <span className={styles.verifyPhaseName}>{PHASE_NAMES[k] || k}</span>
                </div>
                {conflicts.length > 0 && (
                  <ul className={styles.verifyConflicts}>
                    {conflicts.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Harness Findings ───
function HarnessPanel({ harness, schemaErrors }) {
  const blocking = harness?.blocking || [];
  const advisory = harness?.advisory || [];
  const schema = schemaErrors || [];
  if (blocking.length === 0 && advisory.length === 0 && schema.length === 0) return null;

  return (
    <Collapsible
      title="Harness Findings"
      icon={Shield}
      color={blocking.length > 0 ? '#f87171' : '#f59e0b'}
      badge={blocking.length + advisory.length + schema.length}
      defaultOpen={blocking.length > 0}
    >
      {schema.length > 0 && (
        <>
          <p className={styles.doeNote}><strong>Schema errors (unresolved after repair attempts)</strong></p>
          <ul className={styles.openList}>
            {schema.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      )}
      {blocking.length > 0 && (
        <>
          <p className={styles.doeNote}><strong>Blocking — these fail verification</strong></p>
          <ul className={styles.openList}>
            {blocking.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      )}
      {advisory.length > 0 && (
        <>
          <p className={styles.doeNote}><strong>Advisory — recorded, does not fail verification</strong></p>
          <ul className={styles.openList}>
            {advisory.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      )}
    </Collapsible>
  );
}

// ─── Physicochemical Profile — handles both array and flat-object schemas ───
function PhyschemSection({ profile }) {
  if (!profile) return null;

  // New schema: flat object { Mw, logP, solubility, notes }
  if (!Array.isArray(profile)) {
    const rows = [
      { label: 'Molecular Weight', value: profile.Mw, unit: 'g/mol' },
      { label: 'LogP', value: profile.logP, unit: '' },
      { label: 'Solubility', value: profile.solubility, unit: '' },
    ].filter(r => r.value != null && r.value !== '');

    return (
      <Collapsible title="Physicochemical Profile" icon={Beaker} color="#10b981" badge={rows.length} defaultOpen>
        <div className={styles.tableWrap}>
          <table className={styles.propTable}>
            <thead><tr><th>Property</th><th>Value</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={styles.propRow}>
                  <td className={styles.propName}>{r.label}</td>
                  <td className={styles.propValue}>{String(r.value)} <span className={styles.propUnit}>{r.unit}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {profile.notes && <p className={styles.muted} style={{ paddingTop: 8 }}>{profile.notes}</p>}
      </Collapsible>
    );
  }

  // Legacy array schema
  if (profile.length === 0) return null;
  return (
    <Collapsible title="Physicochemical Profile" icon={Beaker} color="#10b981" badge={profile.length} defaultOpen>
      <div className={styles.tableWrap}>
        <table className={styles.propTable}>
          <thead><tr><th>Property</th><th>Value</th><th>Class</th><th>Method</th><th>Source</th></tr></thead>
          <tbody>
            {profile.map((p, i) => (
              <tr key={i} className={styles.propRow}>
                <td className={styles.propName}>{p.property}</td>
                <td className={styles.propValue}>{p.value ?? '—'} <span className={styles.propUnit}>{p.unit}</span></td>
                <td><EvidenceTag cls={p.evidenceClass} /></td>
                <td className={styles.propMethod}>{p.method}</td>
                <td className={styles.propRef}>{p.sourceRef}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Collapsible>
  );
}

// The canonical field is patentExpiry.date. Older/looser emissions used
// differently-named fields; read them as a fallback rather than showing
// "unknown" while the envelope actually carries a date.
function expiryDate(expiry) {
  const candidate =
    expiry.date ||
    expiry.latestFormulationExpiry ||
    expiry.earliestCoreStructureExpiry ||
    expiry.expiryDate;
  return candidate && candidate !== 'unknown' ? candidate : 'unknown';
}

// ─── Executive Summary Card ───
function ExecutiveSummaryCard({ summary }) {
  if (!summary) return null;
  const cfg = STATUS_CONFIG[summary.status] || STATUS_CONFIG.REVIEW;
  const Icon = cfg.icon;
  const expiry = summary.patentExpiry;

  return (
    <div className={styles.summaryCard} style={{ borderLeftColor: cfg.color }}>
      <div className={styles.summaryHeader}>
        <div className={styles.summaryStatusRow}>
          <Icon size={20} style={{ color: cfg.color, flexShrink: 0 }} />
          <span className={styles.summaryStatusLabel} style={{ color: cfg.color }}>{cfg.label}</span>
        </div>
        <p className={styles.summaryRationale}>{summary.rationale}</p>
      </div>
      {expiry && (
        <div className={styles.expiryRow}>
          <span className={styles.expiryLabel}>Patent Expiry:</span>
          <code className={styles.expiryValue}>{expiryDate(expiry)}</code>
          {expiry.basis && expiry.basis !== 'unknown' && (
            <span className={styles.expiryBasis}>({expiry.basis})</span>
          )}
          {expiry.termSettingDate && expiry.termSettingDate !== 'unknown' && (
            <span className={styles.muted}>Term-setting date: {expiry.termSettingDate}</span>
          )}
          {expiry.termSettingPatent && (
            <span className={styles.muted}>Term-setting patent: {expiry.termSettingPatent}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───
export default function FormuGraph() {
  const [form, setForm] = useState({
    molecule: '', dosageForm: 'Tablet', strength: '',
    targetMarkets: ['US'], objective: '',
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [abortController, setAbortController] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const [lastDurationMs, setLastDurationMs] = useState(null);

  // Restore the previous run so a reload or a Fast Refresh does not throw away
  // a four-minute result.
  //
  // This has to be an effect: sessionStorage does not exist during the server
  // render, so seeding it through a useState initialiser would make the first
  // client render disagree with the server's and break hydration. Restoring
  // once on mount is the case the set-state-in-effect rule exists to allow.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const { result: savedResult, durationMs, form: savedForm } = JSON.parse(saved);
      if (!savedResult) return;
      setResult(savedResult);
      setLastDurationMs(durationMs ?? null);
      if (savedForm) setForm(savedForm);
    } catch {
      // A corrupt or oversized entry must never keep the page from loading.
      sessionStorage.removeItem(STORAGE_KEY);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const toggleMarket = (m) => {
    setForm(f => ({
      ...f,
      targetMarkets: f.targetMarkets.includes(m)
        ? f.targetMarkets.filter(x => x !== m)
        : [...f.targetMarkets, m],
    }));
  };

  const loadExample = (ex) => {
    setForm({ ...ex });
    setResult(null);
    setError(null);
  };

  const handleCancel = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
  };

  const handleRun = async () => {
    if (!form.molecule.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setLastDurationMs(null);

    const began = Date.now();
    setStartedAt(began);

    const controller = new AbortController();
    // The client must not be the thing that kills a run. A measured Metformin
    // run takes 280 s and a slower molecule exceeded the previous 6-minute
    // abort, throwing away a nearly-complete analysis that the server was still
    // working on. The server's own maxDuration (300 s, and lower on most
    // serverless plans) is the correct ceiling; this is only a backstop for a
    // genuinely dead connection, so it sits well clear of it.
    const timeoutId = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    setAbortController(controller);

    try {
      const res = await fetch('/api/orchestrator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Orchestrator failed');
      const durationMs = Date.now() - began;
      setResult(data);
      setLastDurationMs(durationMs);
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ result: data, durationMs, form, savedAt: Date.now() }),
        );
      } catch {
        // Over quota — the in-memory result is still fine, only the reload
        // safety net is lost, and that is not worth failing the run over.
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setError(
          `Request cancelled — either you cancelled it, or the connection was open for over ` +
            `${formatDuration(CLIENT_TIMEOUT_MS)} with no response. A normal run finishes in about ` +
            `${formatDuration(TYPICAL_RUN_MS)}.`,
        );
      } else if (err.message === 'Failed to fetch') {
        setError('Connection lost. The dev server may have restarted mid-run. Please try again.');
      } else {
        setError(err.message);
      }
    } finally {
      clearTimeout(timeoutId);
      setAbortController(null);
      setLoading(false);
      setStartedAt(null);
    }
  };

  const exportJSON = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `formugraph-${form.molecule || 'envelope'}-${Date.now()}.json`;
    a.click();
    // Without this the blob is retained for the lifetime of the document.
    URL.revokeObjectURL(url);
  };

  // Handle both envelope shapes returned by orchestrator
  const env = result?.envelope?.developmentConstraintEnvelope
    || result?.developmentConstraintEnvelope
    || result?.envelope;
  const trace = result?.executionTrace || [];

  return (
    <div className={styles.root}>
      {/* ─── Left: Input Panel ─── */}
      <div className={styles.inputPanel}>
        <div className={styles.inputHeader}>
          <h2 className={styles.inputTitle}>New Analysis</h2>
          <p className={styles.inputSubtitle}>Development Constraint Envelope Generator</p>
          <p className={styles.inputDesc}>Powered by autonomous sub-agents. Follows a 6-phase orchestration protocol.</p>
        </div>

        {/* Quick Start Examples */}
        <div className={styles.exampleSection}>
          <span className={styles.sectionLabel}>Quick Start</span>
          <div className={styles.exampleButtons}>
            {EXAMPLE_INPUTS.map((ex, i) => (
              <button key={i} className={styles.exampleBtn} onClick={() => loadExample(ex)}>
                {ex.molecule} · {ex.dosageForm}
              </button>
            ))}
          </div>
        </div>

        {/* Form Fields */}
        <div className={styles.formGroup}>
          <label className={styles.label}>Molecule (INN)</label>
          <input className={styles.input} value={form.molecule}
            onChange={e => setForm(f => ({ ...f, molecule: e.target.value }))}
            placeholder="e.g. Metformin, Semaglutide, Paracetamol" />
        </div>

        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Dosage Form</label>
            <select className={styles.input} value={form.dosageForm}
              onChange={e => setForm(f => ({ ...f, dosageForm: e.target.value }))}>
              {DOSAGE_FORMS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Strength</label>
            <input className={styles.input} value={form.strength}
              onChange={e => setForm(f => ({ ...f, strength: e.target.value }))}
              placeholder="e.g. 500mg, 1mg/mL" />
          </div>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.label}>Target Markets</label>
          <div className={styles.marketGrid}>
            {MARKETS.map(m => (
              <button key={m}
                className={`${styles.marketBtn} ${form.targetMarkets.includes(m) ? styles.marketBtnActive : ''}`}
                onClick={() => toggleMarket(m)}>
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.label}>Objective</label>
          <textarea className={`${styles.input} ${styles.textarea}`}
            value={form.objective}
            onChange={e => setForm(f => ({ ...f, objective: e.target.value }))}
            placeholder="e.g. Generic development, design-around existing formulation patents, FTO clearance" />
        </div>

        <button className={styles.runBtn} onClick={handleRun}
          disabled={loading || !form.molecule.trim()}>
          {loading
            ? <><Loader2 size={18} className={styles.spin} /> Running 6-phase protocol...</>
            : <><Zap size={18} /> Generate Constraint Envelope</>}
        </button>

        {loading && (
          <div className={styles.loadingHint}>
            <RunTimer key={startedAt} startedAt={startedAt} />
            <p>The orchestrator is querying structured datastores, patent databases, and running cross-domain fusion.</p>
            <button className={styles.cancelBtn} onClick={handleCancel}>
              ✕ Cancel
            </button>
          </div>
        )}

        {error && (
          <div className={styles.errorBox}>
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* ─── Right: Results Panel ─── */}
      <div className={styles.resultsPanel}>

        {/* Empty state */}
        {!result && !loading && (
          <div className={styles.emptyState}>
            <Beaker size={56} className={styles.emptyIcon} />
            <h3>Orchestrator Ready</h3>
            <p>Enter a molecule and click &ldquo;Generate Constraint Envelope&rdquo; to run the full 6-phase protocol using autonomous reasoning and live datastores.</p>
            <div className={styles.phaseList}>
              {PHASE_LABELS.map((p, i) => (
                <div key={i} className={styles.phaseItem}>
                  <span className={styles.phaseNum}>{i}</span>
                  <span>{p}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className={styles.loadingPanel}>
            <div className={styles.loadingSpinWrap}>
              <Loader2 size={48} className={styles.spin} />
              <Activity size={20} className={styles.loadingPulse} />
            </div>
            <h3>Orchestrator is reasoning...</h3>
            <p>Managing {NUM_AGENTS} sub-agents across structured and unstructured datastores</p>
            <RunTimer key={startedAt} startedAt={startedAt} />
            <div className={styles.phaseList} style={{ marginTop: 0, maxWidth: 360 }}>
              {PHASE_LABELS.map((p, i) => (
                <div key={i} className={styles.phaseItem}>
                  <span className={styles.phaseNum}>{i}</span>
                  <span>{p}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <ResultErrorBoundary result={result}>
          <div className={styles.envelopeRoot}>

            {/* Header */}
            <div className={styles.envelopeHeader}>
              <div>
                <h2 className={styles.envelopeTitle}>Development Constraint Envelope</h2>
                <p className={styles.envelopeMeta}>
                  {form.molecule} · {form.dosageForm} · {form.strength} · {form.targetMarkets.join('/')} ·&nbsp;
                  {result.iterations} agent iterations · {result.generatedAt ? new Date(result.generatedAt).toLocaleTimeString() : '—'}
                  {lastDurationMs != null && <> · took {formatDuration(lastDurationMs)}</>}
                </p>
              </div>
              <button className={styles.exportBtn} onClick={exportJSON}>
                <Download size={14} /> Download JSON
              </button>
            </div>

            {/* Verification Banner */}
            <VerificationPanel verification={env?.verification} />

            {/* Harness findings — blocking failures separated from advisories,
                so a routine evidence downgrade no longer reads as a failure. */}
            <HarnessPanel harness={result?.envelope?._harness} schemaErrors={result?.envelope?._schemaErrors} />

            {/* Raw text fallback — parse failed */}
            {env?.rawText && (
              <div className={styles.rawTextCard}>
                <div className={styles.rawTextHeader}>
                  <FileText size={16} />
                  <span>Orchestrator Output (raw — JSON parse failed)</span>
                </div>
                <pre className={styles.rawTextBody}>{env.rawText}</pre>
              </div>
            )}

            {/* Executive Summary */}
            <ExecutiveSummaryCard summary={env?.executiveSummary} />

            {/* Physicochemical Profile */}
            <PhyschemSection profile={env?.physicochemicalProfile} />

            {/* FTO Risk Map */}
            {env?.ftoRiskMap && <FTORiskMapCard ftoRiskMap={env.ftoRiskMap} />}

            {/* Design Corridors */}
            {env?.designCorridors?.length > 0 && (
              <Collapsible title="Design Corridors" icon={Zap} color="#22d3ee" badge={env.designCorridors.length} defaultOpen>
                <div className={styles.corridorList}>
                  {env.designCorridors.map((c, i) => <CorridorCard key={i} corridor={c} />)}
                </div>
              </Collapsible>
            )}

            {/* DOE Constraints */}
            {env?.constraintsForDOE?.length > 0 && (
              <Collapsible title="Constraints for DOE" icon={List} color="#a78bfa" badge={env.constraintsForDOE.length} defaultOpen>
                <p className={styles.doeNote}>Handoff payload for the DOE generator. Each entry is traceable to a sourceRef.</p>
                <DOETable constraints={env.constraintsForDOE} />
              </Collapsible>
            )}

            {/* Conflicts */}
            {env?.conflicts?.length > 0 && (
              <Collapsible title="Conflicts" icon={AlertTriangle} color="#f59e0b" badge={env.conflicts.length}>
                {env.conflicts.map((c, i) => (
                  <div key={i} className={styles.conflictCard}>
                    <strong className={styles.conflictTopic}>{c.topic}</strong>
                    <div className={styles.conflictRow}>
                      <span className={styles.conflictLabel}>Position A:</span>
                      <span>{typeof c.positionA === 'object' ? JSON.stringify(c.positionA) : c.positionA}</span>
                    </div>
                    <div className={styles.conflictRow}>
                      <span className={styles.conflictLabel}>Position B:</span>
                      <span>{typeof c.positionB === 'object' ? JSON.stringify(c.positionB) : c.positionB}</span>
                    </div>
                    <div className={styles.conflictRow}>
                      <span className={styles.conflictLabel}>Precedence:</span>
                      <span>{c.precedenceApplied}</span>
                    </div>
                    {c.unresolved && <span className={styles.unresolvedTag}>⚠ Unresolved</span>}
                  </div>
                ))}
              </Collapsible>
            )}

            {/* Open Questions */}
            {env?.openQuestions?.length > 0 && (
              <Collapsible title="Open Questions" icon={HelpCircle} color="#94a3b8" badge={env.openQuestions.length}>
                <ul className={styles.openList}>
                  {env.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              </Collapsible>
            )}

            {/* Citation Ledger */}
            {env?.citationLedger?.length > 0 && (
              <Collapsible title="Citation Ledger" icon={BookOpen} color="#64748b" badge={env.citationLedger.length}>
                <div className={styles.tableWrap}>
                  <table className={styles.citeTable}>
                    <thead><tr><th>Ref ID</th><th>Type</th><th>Locator</th><th>Retrieved</th></tr></thead>
                    <tbody>
                      {env.citationLedger.map((c, i) => (
                        <tr key={i}>
                          <td><code>{c.refId}</code></td>
                          <td>{c.type}</td>
                          <td className={styles.propRef}>{c.locator}</td>
                          <td className={styles.muted}>{c.retrievedAt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Collapsible>
            )}

            {/* Execution Trace */}
            {trace.length > 0 && (
              <Collapsible title={`Execution Trace (${trace.length} tool calls)`} icon={FileText} color="#475569">
                <div className={styles.traceList}>
                  {trace.map((t, i) => (
                    <div key={i} className={styles.traceItem}>
                      <div className={styles.traceHeader}>
                        <code className={styles.traceTool}>{t.tool || t.phase}</code>
                        <span className={t.status === 'error' ? styles.traceError : styles.traceOk}>{t.status || '—'}</span>
                        <span className={styles.muted}>{t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : ''}</span>
                      </div>
                      {t.error && <p className={styles.traceErrorMsg}>{t.error}</p>}
                      {t.outputSummary && <p className={styles.traceSummary}>{t.outputSummary}</p>}
                      {typeof t.durationMs === 'number' && (
                        <p className={styles.muted}>{(t.durationMs / 1000).toFixed(1)}s</p>
                      )}
                      {t.outputPreview && (
                        <details>
                          <summary className={styles.muted}>Raw output (audit)</summary>
                          <pre className={styles.rawTextBody}>{t.outputPreview}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              </Collapsible>
            )}

            {/* Raw JSON */}
            <Collapsible title="Full Raw JSON Envelope" icon={FileText} color="#334155">
              <div className={styles.rawJsonActions}>
                <button className={styles.exportBtn} onClick={exportJSON}>
                  <Download size={14} /> Download formugraph-{form.molecule}.json
                </button>
              </div>
              <pre className={styles.rawJson}>{JSON.stringify(result, null, 2)}</pre>
            </Collapsible>

          </div>
          </ResultErrorBoundary>
        )}
      </div>
    </div>
  );
}
