import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApp, TIME_RANGES } from '../state/AppContext';
import { IS_DEMO } from '../api/client';
import { timeAgo } from '../lib/format';
import logoUrl from '../assets/logo.png';
import {
  IconOverview,
  IconThroughput,
  IconIntrospect,
  IconSizing,
  IconLogs,
  IconCommit,
  IconQueue,
  IconReduction,
  IconSources,
  IconRoutes,
  IconPipelines,
  IconDest,
  IconJobs,
  IconNodes,
  IconValue,
  IconBell,
  IconMail,
  IconRefresh,
} from './icons';

const NAV = [
  { to: '/', label: 'Overview', Icon: IconOverview, title: 'Deployment Overview' },
  { to: '/throughput', label: 'Throughput', Icon: IconThroughput, title: 'Throughput & Volume' },
  {
    to: '/data-wp-introspection',
    label: 'Data WP Introspection',
    Icon: IconIntrospect,
    title: 'Data WP Introspection',
  },
  {
    to: '/sizing-calculator',
    label: 'Sizing Calculator',
    Icon: IconSizing,
    title: 'Sizing Calculator',
  },
  {
    to: '/log-analytics',
    label: 'Log Analytics',
    Icon: IconLogs,
    title: 'Log Analytics',
  },
  {
    to: '/commit-audit-log',
    label: 'Commit Audit Log',
    Icon: IconCommit,
    title: 'Commit Audit Log',
  },
  {
    to: '/persistent-queue-analytics',
    label: 'Persistent Queue Analytics',
    Icon: IconQueue,
    title: 'Persistent Queue Analytics',
  },
  {
    to: '/route-pipeline-reductions',
    label: 'Route/Pipeline Reductions',
    Icon: IconReduction,
    title: 'Route/Pipeline Reductions',
  },
  { to: '/sources', label: 'Sources', Icon: IconSources, title: 'Sources' },
  { to: '/routes', label: 'Routes', Icon: IconRoutes, title: 'Route Health' },
  { to: '/pipelines', label: 'Pipelines', Icon: IconPipelines, title: 'Pipeline Health' },
  { to: '/destinations', label: 'Destinations', Icon: IconDest, title: 'Destinations' },
  { to: '/jobs', label: 'Collectors', Icon: IconJobs, title: 'Collection Jobs' },
  { to: '/nodes', label: 'Worker Nodes', Icon: IconNodes, title: 'Worker & Edge Nodes' },
  { to: '/alerts', label: 'Alerts', Icon: IconMail, title: 'Alerts' },
  { to: '/notifications', label: 'Notifications', Icon: IconBell, title: 'System Notifications' },
  { to: '/value', label: 'Data Value', Icon: IconValue, title: 'Data Reduction Value' },
];

function BrandMark() {
  return <img className="brand-mark" src={logoUrl} alt="" />;
}

export function Layout() {
  const { groups, group, setGroup, range, setRangeId, refresh, lastRefresh, tick } = useApp();
  const loc = useLocation();
  const active = NAV.find((n) => n.to === loc.pathname) ?? NAV[0];
  const now = Date.now();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">CriblVision</div>
            <div className="brand-sub">Health Monitoring</div>
          </div>
        </div>
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          >
            <Icon />
            {label}
          </NavLink>
        ))}
        <div className="nav-spacer" />
        <div className="nav-foot">
          {IS_DEMO ? 'Demo data' : 'Live'} · updated {timeAgo(lastRefresh, now)}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{active.title}</h1>
            <span className="sub">
              {group === 'all' ? 'All groups & fleets' : group} · {range.label.toLowerCase()}
            </span>
          </div>
          <div className="topbar-spacer" />
          {IS_DEMO && <span className="demo-badge">DEMO DATA</span>}

          <div className="control">
            <select
              className="select"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              aria-label="Worker group"
            >
              <option value="all">All groups</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.id} {g.type === 'edge' ? '(edge)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="control">
            <select
              className="select"
              value={range.id}
              onChange={(e) => setRangeId(e.target.value)}
              aria-label="Time range"
            >
              {TIME_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <button className="btn" onClick={refresh} title="Refresh now">
            <IconRefresh key={tick} />
            Refresh
          </button>
        </header>

        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
