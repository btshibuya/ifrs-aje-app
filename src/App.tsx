import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { FeedbackProvider } from './components/feedback'
import ThemePicker from './components/ThemePicker'
import { Loading } from './components/ui'

// 画面ごとに分けて読み込む（最初に開く画面に必要な分だけ読む）
const ChangeLogPage = lazy(() => import('./pages/ChangeLogPage'))
const ChecksPage = lazy(() => import('./pages/ChecksPage'))
const HomePage = lazy(() => import('./pages/HomePage'))
const ImpactPage = lazy(() => import('./pages/ImpactPage'))
const MastersPage = lazy(() => import('./pages/MastersPage'))
const MaterialsPage = lazy(() => import('./pages/MaterialsPage'))
const PackagePage = lazy(() => import('./pages/package/PackagePage'))
const PolicyPage = lazy(() => import('./pages/PolicyPage'))
const ProgressPage = lazy(() => import('./pages/ProgressPage'))
const WorkPage = lazy(() => import('./pages/work/WorkPage'))

const NAV = [
  { to: '/', label: 'ホーム', end: true },
  { to: '/progress', label: '進捗一覧' },
  { to: '/materials', label: '資料一覧' },
  { to: '/package', label: '収集パッケージ' },
  { to: '/policies', label: '会社別方針一覧' },
  { to: '/impact', label: '論点別影響額' },
  { to: '/checks', label: 'チェック' },
  { to: '/logs', label: '変更履歴' },
  { to: '/masters', label: 'マスタ' },
]

// ブラウザのタブ名に、いまの画面名を出す
const TITLES: [RegExp, string][] = [
  [/^\/$/, 'ホーム'], [/^\/progress/, '進捗一覧'], [/^\/materials/, '資料一覧'], [/^\/package/, '収集パッケージ'],
  [/^\/policies/, '会社別方針一覧'], [/^\/work/, '作業画面'], [/^\/impact/, '論点別影響額'], [/^\/checks/, 'チェック'],
  [/^\/logs/, '変更履歴'], [/^\/masters/, 'マスタ'],
]
function TitleSync() {
  const { pathname } = useLocation()
  useEffect(() => {
    const t = TITLES.find(([re]) => re.test(pathname))?.[1]
    document.title = t ? `${t}｜IFRS AJE` : 'IFRS AJE'
  }, [pathname])
  return null
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
          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/progress" element={<ProgressPage />} />
            <Route path="/materials" element={<MaterialsPage />} />
            <Route path="/materials/:companyCode" element={<MaterialsPage />} />
            <Route path="/package" element={<PackagePage />} />
            <Route path="/package/:companyCode/:asOf?/:formCode?" element={<PackagePage />} />
            <Route path="/policies" element={<PolicyPage />} />
            <Route path="/work/:periodId/:issueCode" element={<WorkRoute />} />
            <Route path="/impact" element={<ImpactPage />} />
            <Route path="/checks" element={<ChecksPage />} />
            <Route path="/logs" element={<ChangeLogPage />} />
            <Route path="/masters" element={<MastersPage />} />
          </Routes>
          </Suspense>
        </main>
      </div>
      </FeedbackProvider>
    </HashRouter>
  )
}
