import { type ReactNode, useRef, useLayoutEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import GlowFrame from '../GlowFrame.js';
import iconPage from '../../images/icon-page.png';

const navItems = [
  { to: '/home', label: 'Home' },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/mapa', label: 'Mapa' },
  { to: '/monitoramento', label: 'Monitoramento' },
  { to: '/especies', label: 'Espécies' },
];

const bottomNavItems: { to: string; label: string; icon: () => ReactNode }[] = [
  { to: '/home', label: 'Home', icon: HomeIcon },
  { to: '/dashboard', label: 'Dashboard', icon: DashboardIcon },
  { to: '/mapa', label: 'Mapa', icon: MapIcon },
  { to: '/monitoramento', label: 'Alertas', icon: MonitorIcon },
  { to: '/especies', label: 'Espécies', icon: SpeciesIcon },
];

function HomeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function DashboardIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </svg>
  );
}

function SpeciesIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a4 4 0 0 0-4 4c0 2.5 2 4 4 6.5 2-2.5 4-4 4-6.5a4 4 0 0 0-4-4z" />
      <path d="M12 12c-3.5 0-6 2.5-6 6v4h12v-4c0-3.5-2.5-6-6-6z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4.5 8-12V5l-8-3-8 3v5c0 7.5 8 12 8 12z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export default function Header() {
  const location = useLocation();
  const navRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const bottomRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [indicator, setIndicator] = useState({ left: 0, width: 0, visible: false });
  const [bottomIndicator, setBottomIndicator] = useState({ left: 0, width: 0, visible: false });

  useLayoutEffect(() => {
    const activePath = navItems.find((n) => location.pathname.startsWith(n.to))?.to ?? navItems[0].to;
    const el = navRefs.current[activePath];
    if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth, visible: true });
    const bottomEl = bottomRefs.current[activePath];
    if (bottomEl) setBottomIndicator({ left: bottomEl.offsetLeft, width: bottomEl.offsetWidth, visible: true });
  }, [location.pathname]);

  return (
    <>
      <header className="app-header app-header--dark">
        <div className="header-inner container">
          <div className="header-brand">
            <img src={iconPage} alt="" width="28" height="28" />
            <span className="brand-name">BioGuardians</span>
          </div>

          <nav className="header-nav" aria-label="Navegação principal">
            <GlowFrame>
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  ref={(el) => { navRefs.current[item.to] = el; }}
                  to={item.to}
                  end={item.to === '/home'}
                  className="header-nav-link"
                >
                  {item.label}
                </NavLink>
              ))}
              <span
                className="header-nav-indicator"
                style={{ left: indicator.left, width: indicator.width, opacity: indicator.visible ? 1 : 0 }}
              />
            </GlowFrame>
          </nav>
        </div>
      </header>

      <nav className="bottom-nav" aria-label="Navegação mobile">
        {bottomNavItems.map((item) => (
          <NavLink
            key={item.to}
            ref={(el) => { bottomRefs.current[item.to] = el; }}
            to={item.to}
            end={item.to === '/home'}
            className="bottom-nav-link"
          >
            {item.icon()}
            <span>{item.label}</span>
          </NavLink>
        ))}
        <span
          className="bottom-nav-indicator"
          style={{ left: bottomIndicator.left, width: bottomIndicator.width, opacity: bottomIndicator.visible ? 1 : 0 }}
        />
      </nav>
    </>
  );
}
