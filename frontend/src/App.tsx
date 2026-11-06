import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/layout/Layout.js';
import HomePage from './pages/HomePage.js';
import MapPage from './pages/MapPage.js';
import DashboardPage from './pages/DashboardPage.js';
import SpeciesPage from './pages/SpeciesPage.js';
import MonitoramentoPage from './pages/MonitoramentoPage.js';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="home" element={<HomePage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="mapa" element={<MapPage />} />
          <Route path="monitoramento" element={<MonitoramentoPage />} />
          <Route path="especies" element={<SpeciesPage />} />
          <Route path="especies/:id" element={<SpeciesPage />} />
          <Route path="sobre" element={<div className="page-placeholder container">Sobre</div>} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
