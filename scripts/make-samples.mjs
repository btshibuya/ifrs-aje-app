// デモ用のサンプル取込ファイルを public/samples に作る
//   node scripts/make-samples.mjs
// 日本基準の償却額は税法の耐用年数による定額法（月割り、取得月を含む）で計算する

import ExcelJS from 'exceljs'
import { mkdirSync, writeFileSync } from 'node:fs'

const OUT = new URL('../public/samples/', import.meta.url)
mkdirSync(OUT, { recursive: true })

const mi = (d) => {
  const [y, m] = d.split('-').map(Number)
  return y * 12 + m - 1
}

// 税法の耐用年数による日本基準の期首帳簿価額・当期償却額・期末帳簿価額
function jgaap(asset, start, end) {
  const monthly = asset.cost / (asset.taxLife * 12)
  const a = mi(asset.acquired)
  const s = mi(start)
  const e = asset.disposed ? Math.min(mi(asset.disposed), mi(end)) : mi(end)
  const inPeriod = a >= s
  // 帳簿価額は取得からの経過月数で計算し、償却額はその差とする（期をまたいでも端数がずれない）
  const bvAfter = (months) => Math.max(Math.round(asset.cost - monthly * months), 0)
  const open = inPeriod ? 0 : bvAfter(s - a)
  const atEnd = bvAfter(e - a + 1)
  const dep = (inPeriod ? asset.cost : open) - atEnd
  return { open, dep, close: asset.disposed ? 0 : atEnd }
}

const S01_ASSETS = [
  { no: 'A001', name: '本社工場', type: '建物', acquired: '2010-04-01', cost: 300_000_000, taxLife: 38 },
  { no: 'A002', name: '空調設備', type: '建物附属設備', acquired: '2018-07-01', cost: 25_000_000, taxLife: 15 },
  { no: 'A003', name: 'マシニングセンタ', type: '機械装置', acquired: '2020-10-01', cost: 48_000_000, taxLife: 10 },
  { no: 'A004', name: 'プレス機', type: '機械装置', acquired: '2023-04-01', cost: 36_000_000, taxLife: 10 },
  { no: 'A005', name: '配送トラック', type: '車両運搬具', acquired: '2021-09-01', cost: 6_000_000, taxLife: 5 },
  { no: 'A006', name: '検査用サーバー', type: '工具器具備品', acquired: '2024-01-01', cost: 4_800_000, taxLife: 5 },
  { no: 'A007', name: '生産管理システム', type: 'ソフトウェア', acquired: '2023-10-01', cost: 12_000_000, taxLife: 5 },
  { no: 'A008', name: '旧型旋盤', type: '機械装置', acquired: '2014-04-01', cost: 20_000_000, taxLife: 10 },
  { no: 'A009', name: 'レーザー加工機', type: '機械装置', acquired: '2025-08-01', cost: 60_000_000, taxLife: 10 },
]

// 2027年3月期：旧型旋盤を除却、配送トラックが台帳から消えている（処理漏れのデモ）、3D測定機を取得
const S01_ASSETS_NEXT = [
  ...S01_ASSETS.filter((a) => a.no !== 'A005').map((a) => (a.no === 'A008' ? { ...a, disposed: '2026-09-30' } : a)),
  { no: 'A010', name: '3D測定機', type: '工具器具備品', acquired: '2026-05-01', cost: 8_000_000, taxLife: 5 },
]

const S04_ASSETS = [
  { no: 'B001', name: '店舗内装', type: '建物附属設備', acquired: '2019-04-01', cost: 15_000_000, taxLife: 10 },
  { no: 'B002', name: '業務用車両', type: '車両運搬具', acquired: '2022-04-01', cost: 4_200_000, taxLife: 6 },
  { no: 'B003', name: 'POSシステム', type: 'ソフトウェア', acquired: '2024-04-01', cost: 3_000_000, taxLife: 5 },
  // 区分マッピングにない種類（取込後の計算で警告が出るデモ）
  { no: 'B004', name: '応接セット', type: '器具備品', acquired: '2023-07-01', cost: 1_200_000, taxLife: 8 },
]

async function writeAssets(file, assets, start, end, headers) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('固定資産台帳')
  ws.addRow(headers)
  for (const a of assets) {
    const j = jgaap(a, start, end)
    ws.addRow([
      a.no, a.name, a.type, new Date(`${a.acquired}T00:00:00Z`), a.cost, a.taxLife,
      j.open, j.dep, j.close, a.disposed ? new Date(`${a.disposed}T00:00:00Z`) : null,
    ])
  }
  ws.getRow(1).font = { bold: true }
  ws.columns.forEach((c, i) => {
    c.width = [10, 18, 14, 12, 14, 10, 14, 12, 14, 12][i]
    if ([3, 9].includes(i)) c.numFmt = 'yyyy/mm/dd'
    if ([4, 6, 7, 8].includes(i)) c.numFmt = '#,##0'
  })
  await wb.xlsx.writeFile(new URL(file, OUT))
}

const STD = ['資産番号', '資産名称', '資産種類', '取得年月日', '取得価額', '耐用年数', '期首帳簿価額', '当期償却額', '期末帳簿価額', '除却年月日']
const YAYOI = ['資産コード', '資産名', '勘定科目', '取得日', '取得価額', '耐用年数', '期首簿価', '償却額', '期末簿価', '除却日']

await writeAssets('S01_固定資産台帳_2026年3月期.xlsx', S01_ASSETS, '2025-04-01', '2026-03-31', STD)
await writeAssets('S01_固定資産台帳_2027年3月期.xlsx', S01_ASSETS_NEXT, '2026-04-01', '2027-03-31', STD)
await writeAssets('S04_固定資産台帳_2026年3月期.xlsx', S04_ASSETS, '2025-04-01', '2026-03-31', YAYOI)

// 有給休暇の残日数一覧
const SURNAMES = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '清水', '山崎', '森', '池田']
const GIVEN = ['健太', '美咲', '大輔', '陽子', '翔', '由美', '拓也', '恵', '誠', '彩', '直樹', '真理', '亮', '香織', '剛', '愛', '浩二', '理恵', '悠斗', '千尋', '隆', '舞']

function employees(prefix, n, seed) {
  return Array.from({ length: n }, (_, i) => {
    const r = (i * 7 + seed) % 11
    return {
      no: `${prefix}${String(i + 1).padStart(3, '0')}`,
      name: `${SURNAMES[(i + seed) % SURNAMES.length]} ${GIVEN[(i * 3 + seed) % GIVEN.length]}`,
      days: 6 + r * 2 + (i % 3) * 0.5,
      wage: 14000 + ((i * 1300 + seed * 500) % 16000),
    }
  })
}

function writeLeave(file, rows) {
  const lines = ['社員番号,氏名,有給残日数,日額給与', ...rows.map((e) => `${e.no},${e.name},${e.days},"${e.wage.toLocaleString('ja-JP')}"`)]
  writeFileSync(new URL(file, OUT), '﻿' + lines.join('\r\n') + '\r\n')
}

const s01 = employees('E', 20, 3)
writeLeave('S01_有給残日数_2026年3月期.csv', s01)
// 翌期：E005が退職、2名が入社、残日数と日額が変わる
const s01Next = [
  ...s01.filter((e) => e.no !== 'E005').map((e, i) => ({ ...e, days: Math.max(e.days + ((i % 5) - 2), 0), wage: e.wage + 300 })),
  { no: 'E021', name: '新井 葵', days: 10, wage: 13500 },
  { no: 'E022', name: '石川 蓮', days: 10, wage: 13500 },
]
writeLeave('S01_有給残日数_2027年3月期.csv', s01Next)
writeLeave('S02_有給残日数_2026年3月期.csv', employees('K', 12, 5))

console.log('public/samples にサンプルを作りました')
