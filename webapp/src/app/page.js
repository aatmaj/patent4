'use client';

import { useState } from 'react';
import styles from './page.module.css';
import Sidebar from '../components/Sidebar';
import FormuGraph from '../components/FormuGraph';

import AgentTopology from '../components/AgentTopology';

export default function Home() {
  const [activeModule, setActiveModule] = useState('formugraph');

  const handleModuleChange = (mod) => {
    setActiveModule(mod);
  };

  return (
    <div className={styles.appShell}>
      <Sidebar activeModule={activeModule} onModuleChange={handleModuleChange} />

      <main className={styles.main}>
        {activeModule === 'formugraph' && <FormuGraph />}
        {activeModule === 'topology' && <AgentTopology />}
      </main>
    </div>
  );
}
