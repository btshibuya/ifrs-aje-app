import { HashRouter, NavLink, Route, Routes, useParams } from 'react-router-dom'
import ChangeLogPage from './pages/ChangeLogPage'
import ChecksPage from './pages/ChecksPage'
import ImpactPage from './pages/ImpactPage'
import MastersPage from './pages/MastersPage'
import PolicyPage from './pages/PolicyPage'
import ProgressPage from './pages/ProgressPage'
import WorkPage from './pages/work/WorkPage'

const NAV = [
  { to: '/', label: '進捗一覧', end: true },
  { to: '/policies', label: '会社別方針一覧' },
  { to: '/impact', label: '論点別影響額' },
  { to: '/checks', label: 'チェック' },
  { to: '/logs', label: '変更履歴' },
  { to: '/masters', label: 'マスタ' },
]

// 会社・期・論点が変わったら作業画面を作り直す（タブの選択などを初期化する）
function WorkRoute() {
  const { periodId, issueCode } = useParams()
  return <WorkPage key={`${periodId}/${issueCode}`} />
}

export default function App() {
  return (
    <HashRouter>
      <div className="app">
        <header className="app-header">
          <div className="brand">IFRS 調整仕訳（AJE）<span className="brand-sub">プロトタイプ・ダミーデータ</span></div>
          <nav>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')}>{n.label}</NavLink>
            ))}
          </nav>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<ProgressPage />} />
            <Route path="/policies" element={<PolicyPage />} />
            <Route path="/work/:periodId/:issueCode" element={<WorkRoute />} />
            <Route path="/impact" element={<ImpactPage />} />
            <Route path="/checks" element={<ChecksPage />} />
            <Route path="/logs" element={<ChangeLogPage />} />
            <Route path="/masters" element={<MastersPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
