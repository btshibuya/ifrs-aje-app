import { useEffect } from 'react'
import { HashRouter, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { FeedbackProvider } from './components/feedback'
import ThemePicker from './components/ThemePicker'

// 画面は分けずに読み込む（画面ごとに分けると、画面のファイルを読んでからデータを読み始めるため、
// 実測で初回表示が約2割遅くなった。Excel・CSVの読み取りだけは、取り込むときに読む）
import ChangeLogPage from './pages/ChangeLogPage'
import ChecksPage from './pages/ChecksPage'
import ConsolidationPage from './pages/consolidation/ConsolidationPage'
import HelpPage from './pages/HelpPage'
import HomePage from './pages/HomePage'
import ImpactPage from './pages/ImpactPage'
import MastersPage from './pages/MastersPage'
import MaterialsPage from './pages/MaterialsPage'
import PackagePage from './pages/package/PackagePage'
import PolicyPage from './pages/PolicyPage'
import ProgressPage from './pages/ProgressPage'
import ReportPage from './pages/ReportPage'
import WorkPage from './pages/work/WorkPage'

const NAV = [
  { to: '/', label: 'ホーム', end: true },
  { to: '/progress', label: '進捗一覧' },
  { to: '/materials', label: '資料一覧' },
  { to: '/package', label: '収集パッケージ' },
  { to: '/consolidation', label: '連結精算表' },
  { to: '/policies', label: '会社別方針一覧' },
  { to: '/impact', label: '論点別影響額' },
  { to: '/checks', label: 'チェック' },
  { to: '/logs', label: '変更履歴' },
  { to: '/masters', label: 'マスタ' },
  { to: '/help', label: '論点の解説' },
]

// ブラウザのタブ名に、いまの画面名を出す
const TITLES: [RegExp, string][] = [
  [/^\/$/, 'ホーム'], [/^\/progress/, '進捗一覧'], [/^\/materials/, '資料一覧'], [/^\/package/, '収集パッケージ'], [/^\/consolidation/, '連結精算表'],
  [/^\/policies/, '会社別方針一覧'], [/^\/work/, '作業画面'], [/^\/report/, '検証レポート'], [/^\/impact/, '論点別影響額'], [/^\/checks/, 'チェック'],
  [/^\/logs/, '変更履歴'], [/^\/masters/, 'マスタ'], [/^\/help/, '論点の解説'],
]
function TitleSync() {
  const { pathname } = useLocation()
  useEffect(() => {
    const t = TITLES.find(([re]) => re.test(pathname))?.[1]
    document.title = t ? `${t}｜IFRS AJE` : 'IFRS AJE'
  }, [pathname])
  return null
}

// 検証レポートも、対象が変わったら作り直す（前の会社の内容や判定を一瞬でも出さない）
function ReportRoute() {
  const { periodId, issueCode } = useParams()
  return <ReportPage key={`${periodId}/${issueCode}`} />
}

// 会社・期・論点が変わったら作業画面を作り直す（タブの選択などを初期化する）
function WorkRoute() {
  const { periodId, issueCode } = useParams()
  return <WorkPage key={`${periodId}/${issueCode}`} />
}

export default function App() {
  return (
    <HashRouter>
      <FeedbackProvider>
      <TitleSync />
      <div className="app">
        <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus() }}>本文へ移動</a>
        <header className="app-header">
          <div className="brand">IFRS 調整仕訳（AJE）<span className="brand-sub">プロトタイプ・ダミーデータ</span></div>
          <nav>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')}>{n.label}</NavLink>
            ))}
          </nav>
          <ThemePicker />
        </header>
        <main className="app-main" id="main" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/progress" element={<ProgressPage />} />
            <Route path="/materials" element={<MaterialsPage />} />
            <Route path="/materials/:companyCode" element={<MaterialsPage />} />
            <Route path="/package" element={<PackagePage />} />
            <Route path="/package/:companyCode/:asOf?/:formCode?" element={<PackagePage />} />
            <Route path="/consolidation" element={<ConsolidationPage />} />
            <Route path="/policies" element={<PolicyPage />} />
            <Route path="/work/:periodId/:issueCode" element={<WorkRoute />} />
            <Route path="/report/:periodId/:issueCode" element={<ReportRoute />} />
            <Route path="/impact" element={<ImpactPage />} />
            <Route path="/checks" element={<ChecksPage />} />
            <Route path="/logs" element={<ChangeLogPage />} />
            <Route path="/masters" element={<MastersPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/help/:code" element={<HelpPage />} />
          </Routes>
        </main>
      </div>
      </FeedbackProvider>
    </HashRouter>
  )
}
