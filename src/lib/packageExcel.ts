// 収集パッケージの Excel ダウンロード・アップロード
// 1つのブックに「はじめに」と「入力」の2シートを作る。「入力」には全様式を上から順に並べ、先頭の目次から各様式へ移れる
// 入力する欄だけ書き込めるようにし（シートの保護）、選択肢は入力規則（リスト）にする
// 様式の見分けと項目の読み取りには、隠した1列目（A列）の目印を使う（form:様式コード、f:項目キー、keys、例、none、note）
// 前の形（様式ごとのシート）のファイルも読み取れる
// Excel の読み書きのライブラリは大きいため、ボタンを押したときにだけ読み込む

import { formatAsOf, type PackageForm, type PkgField } from './materials'
import { UNIT, formatNumber, isNumeric, parseNumber, type EntryData } from './package'

const loadExcel = async () => (await import('exceljs')).default

// アプリと同じ書体（Windows ではメイリオ。アプリの指定の中で Windows にあるもの）
const FONT_NAME = 'Meiryo'
const FONT_SIZE = 10
const HEAD_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFEEF2F8' } }
const BAND_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFDCE6F4' } }
const INPUT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFFBEA' } }
const EXAMPLE_COLOR = { argb: 'FF8A5A00' }
const MUTED = { argb: 'FF52514E' }
const SPARE_ROWS = 5 // 明細の様式で、入力済みの行のほかに用意する空きの行（足りなければ行を挿入できる）
const LAST_COL = 10 // J列まで使う

const numFmt = (f: PkgField) => (f.type === 'percent' || f.type === 'years' ? '#,##0.00' : f.type === 'days' ? '#,##0.0' : '#,##0')

export interface ExportInput {
  companyLabel: string
  asOf: string
  forms: { form: PackageForm; no?: number; data?: EntryData; prior?: (f: PkgField) => { label: string; value: unknown }[] }[]
}

type Sheet = import('exceljs').Worksheet

// シートのすべての使っているセルを、アプリと同じ書体にする（太字・色などはそのまま）
function applyFont(ws: Sheet) {
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (c) => { c.font = { ...(c.font ?? {}), name: FONT_NAME, size: c.font?.size ?? FONT_SIZE } })
  })
}

export async function exportPackage(input: ExportInput): Promise<Blob> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  wb.creator = 'IFRS AJE'

  // はじめに
  const intro = wb.addWorksheet('はじめに')
  intro.columns = [{ width: 110 }]
  const lines = [
    `収集パッケージ　${input.companyLabel}　基準日 ${formatAsOf(input.asOf)}`,
    '',
    '1. 「入力」シートに、すべての様式を上から順に並べています。先頭の目次の様式名を押すと、その様式へ移ります。',
    '2. 黄色の欄に入力してください（ほかの欄は書き換えられません）。',
    '3. 入力例と前期の値を、同じ行に並べています。金額は円、率は%の数字で入力します（例：1.2% → 1.2）。',
    '4. 明細の様式は、1行に1件です。「例」の行は取り込みません。行が足りなければ、黄色の行の間に行を挿入できます。',
    '5. 入力が終わったら、アプリの収集パッケージで「Excelから取り込む」を選び、このファイルを選んでください。',
    '   取り込むと下書きとして保存されます。内容を確かめてから、アプリで「提出する」を押してください。',
    '6. 隠してあるA列・行（様式を見分ける目印）は変えないでください。',
  ]
  lines.forEach((l, i) => { intro.getCell(`A${i + 1}`).value = l })
  intro.getCell('A1').font = { bold: true, size: 14 }
  applyFont(intro)

  const ws = wb.addWorksheet('入力', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [{ width: 4 }, { width: 34 }, { width: 22 }, { width: 18 }, { width: 18 }, { width: 26 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }]
  ws.getColumn(1).hidden = true
  ws.getCell('B1').value = `収集パッケージ　${input.companyLabel}　基準日 ${formatAsOf(input.asOf)}`
  ws.getCell('B1').font = { bold: true, size: 13 }
  ws.getCell('B2').value = '黄色の欄に入力します。下の様式名を押すと、その様式へ移ります。'
  ws.getCell('B2').font = { color: MUTED }
  ws.getCell('B3').value = '目次'
  ws.getCell('B3').font = { bold: true }

  // 目次の行を先に取り、様式の位置が決まってからリンクを入れる
  const tocStart = 4
  let r = tocStart + input.forms.length + 1
  const band = (row: number) => { for (let c = 2; c <= LAST_COL; c++) ws.getCell(row, c).fill = BAND_FILL }
  const merge = (row: number, from: number) => ws.mergeCells(row, from, row, LAST_COL)

  for (const [idx, { form, no, data, prior }] of input.forms.entries()) {
    const titleRow = r
    ws.getCell(r, 1).value = `form:${form.code}`
    ws.getCell(r, 2).value = `${no ?? idx + 1}. ${form.title}`
    ws.getCell(r, 2).font = { bold: true, size: 12 }
    band(r)
    r++
    ws.getCell(r, 2).value = form.intro
    ws.getCell(r, 2).font = { color: MUTED }
    ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' }
    merge(r, 2)
    ws.getRow(r).height = 30
    r++

    if (form.fields) {
      ws.getCell(r, 1).value = 'head'
      ws.getRow(r).values = ['head', '項目', '単位', '今回の値（入力）', '入力例', '前期の値', '説明・見る場所']
      ws.getRow(r).font = { bold: true }
      for (let c = 2; c <= LAST_COL; c++) ws.getCell(r, c).fill = HEAD_FILL
      merge(r, 7)
      r++
      for (const f of form.fields) {
        const row = ws.getRow(r)
        const priors = prior?.(f) ?? []
        row.values = [
          `f:${f.key}`, `${f.label}${f.required && !f.compute ? '（必須）' : ''}${f.compute ? '（自動計算）' : ''}`, UNIT[f.type] || '',
          (data?.fields?.[f.key] ?? null) as never,
          (isNumeric(f) ? Number(f.example) : String(f.example)) as never,
          priors.slice(0, 2).map((p) => `${p.label}：${p.value === undefined || p.value === null ? '—' : isNumeric(f) ? formatNumber(p.value, f.type) : String(p.value)}`).join('\n'),
          `${f.help}${f.where ? `（見る場所：${f.where}）` : ''}`,
        ]
        merge(r, 7)
        row.getCell(6).alignment = { wrapText: true, vertical: 'top' }
        row.getCell(7).alignment = { wrapText: true, vertical: 'top' }
        row.getCell(5).font = { italic: true, color: EXAMPLE_COLOR }
        row.height = 32
        const cell = row.getCell(4)
        if (!f.compute) {
          cell.fill = INPUT_FILL
          cell.protection = { locked: false }
        }
        if (isNumeric(f)) { cell.numFmt = numFmt(f); row.getCell(5).numFmt = numFmt(f) }
        if (f.type === 'select') cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${f.options!.join(',')}"`] }
        r++
      }
      ws.getCell(r, 1).value = 'note'
      ws.getCell(r, 2).value = '備考（任意）'
      const note = ws.getCell(r, 4)
      note.value = data?.note ?? null
      note.fill = INPUT_FILL
      note.protection = { locked: false }
      ws.mergeCells(r, 4, r, LAST_COL)
      r++
    }

    if (form.table) {
      const t = form.table
      ws.getRow(r).values = ['keys', '', ...t.columns.map((c) => c.key)]
      ws.getRow(r).hidden = true
      r++
      ws.getRow(r).values = ['head', '番号', ...t.columns.map((c) => `${c.label}${c.required ? '（必須）' : ''}${UNIT[c.type] ? `［${UNIT[c.type]}］` : ''}`)]
      ws.getRow(r).font = { bold: true }
      ws.getRow(r).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }
      ws.getRow(r).height = 30
      for (let c = 2; c <= 2 + t.columns.length; c++) ws.getCell(r, c).fill = HEAD_FILL
      r++
      for (const ex of t.example) {
        const row = ws.getRow(r++)
        row.values = ['例', '例', ...t.columns.map((c) => (ex[c.key] ?? null) as never)]
        row.font = { italic: true, color: EXAMPLE_COLOR }
        t.columns.forEach((c, j) => { if (isNumeric(c)) row.getCell(3 + j).numFmt = numFmt(c) })
      }
      const rows = data?.rows ?? []
      for (let i = 0; i < rows.length + SPARE_ROWS; i++) {
        const row = ws.getRow(r++)
        row.getCell(2).value = i + 1
        t.columns.forEach((c, j) => {
          const cell = row.getCell(3 + j)
          const v = rows[i]?.[c.key]
          cell.value = (v === undefined ? null : v) as never
          cell.fill = INPUT_FILL
          cell.protection = { locked: false }
          if (isNumeric(c)) cell.numFmt = numFmt(c)
          if (c.type === 'select') cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${c.options!.join(',')}"`] }
        })
      }
      ws.getCell(r, 1).value = 'none'
      ws.getCell(r, 2).value = `該当なし：「${t.emptyLabel}」場合は、右の欄に ○`
      ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' }
      ws.getRow(r).height = 30
      const none = ws.getCell(r, 3)
      none.value = data?.none ? '○' : null
      none.fill = INPUT_FILL
      none.protection = { locked: false }
      r++
    }
    r++ // 様式の間を1行あける

    // 目次：様式名を押すと、その様式の見出しへ移る
    const toc = ws.getCell(tocStart + idx, 2)
    toc.value = { text: `${no ?? idx + 1}. ${form.title}`, hyperlink: `#'入力'!B${titleRow}` }
    toc.font = { color: { argb: 'FF1F5FBF' }, underline: true }
    const st = data?.rows?.length ? `${data.rows.length}件` : data?.none ? '該当なし' : data?.fields && Object.values(data.fields).some((v) => v !== null && v !== '') ? '入力あり' : '未入力'
    ws.getCell(tocStart + idx, 3).value = st
    ws.getCell(tocStart + idx, 3).font = { color: MUTED }
  }

  applyFont(ws)
  // 入力欄以外を書き換えられないようにする（パスワードなし。様式の崩れを防ぐため）。明細の行は挿入できる
  await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, insertRows: true })
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

// ---------------------------------------------------------------------------
// アップロード：様式を見分けて、入力値を読み取る
// ---------------------------------------------------------------------------

export interface ImportedForm { form: PackageForm; data: EntryData; filled: number; warnings: string[] }

function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] }
    if ('result' in o) return cellValue(o.result) // 数式は計算結果を使う
    if (o.richText) return o.richText.map((x) => x.text).join('')
    if ('text' in o) return String(o.text)
  }
  return v
}

// 項目の型に合わせて値を直す。読めないときは警告を返す
function toFieldValue(f: PkgField, raw: unknown): { value: unknown; warn?: string } {
  const v = cellValue(raw)
  if (v === null || v === '') return { value: null }
  if (isNumeric(f)) {
    if (typeof v === 'number') return { value: v }
    const n = parseNumber(String(v))
    return n === 'error' ? { value: String(v), warn: `「${f.label}」の値「${String(v)}」を数字として読めません` } : { value: n }
  }
  if (f.type === 'date') {
    const s = String(v).trim().replace(/[/.]/g, '-')
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
    return m ? { value: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` } : { value: s, warn: `「${f.label}」の日付「${String(v)}」を読めません` }
  }
  if (f.type === 'select' && !f.options!.includes(String(v).trim())) return { value: String(v).trim(), warn: `「${f.label}」の「${String(v)}」は選択肢にありません` }
  return { value: String(v).trim() }
}

// 明細の1行を読む（keys の列の位置から）。何も入っていなければ null
function readTableRow(form: PackageForm, keys: string[], row: import('exceljs').Row, firstCol: number, at: number, warnings: string[]) {
  const rec: Record<string, unknown> = {}
  let any = false
  const warns: string[] = []
  keys.forEach((k, j) => {
    const c = form.table!.columns.find((x) => x.key === k)
    if (!c) return
    const r = toFieldValue(c, row.getCell(firstCol + j).value)
    if (r.value !== null) any = true
    rec[k] = r.value
    if (r.warn) warns.push(r.warn)
  })
  if (!any) return null
  warnings.push(...warns.map((w) => `${at}行目：${w}`))
  return rec
}

// 前の形：様式ごとのシート（A1「様式コード」、B1 に様式コード）
function readLegacySheet(ws: Sheet, form: PackageForm): ImportedForm {
  const warnings: string[] = []
  const data: EntryData = {}
  let filled = 0
  if (form.fields) {
    data.fields = {}
    ws.eachRow((row, n) => {
      if (n < 5) return
      const key = String(cellValue(row.getCell(1).value) ?? '')
      const f = form.fields!.find((x) => x.key === key)
      if (f && !f.compute) {
        const r = toFieldValue(f, row.getCell(4).value)
        data.fields![f.key] = r.value
        if (r.value !== null) filled++
        if (r.warn) warnings.push(r.warn)
      }
      if (cellValue(row.getCell(2).value) === '備考（任意）') {
        const note = cellValue(row.getCell(4).value)
        if (note) data.note = String(note)
      }
    })
  }
  if (form.table) {
    const keys = (ws.getRow(3).values as unknown[]).slice(2).map((v) => String(cellValue(v) ?? ''))
    data.rows = []
    ws.eachRow((row, n) => {
      if (n < 5) return
      const first = cellValue(row.getCell(1).value)
      if (first === '例') return
      if (first === '該当なし') {
        data.none = String(cellValue(row.getCell(4).value) ?? '').trim() !== ''
        return
      }
      const rec = readTableRow(form, keys, row, 2, data.rows!.length + 1, warnings)
      if (rec) data.rows!.push(rec)
    })
    filled = data.rows.length
  }
  return { form, data, filled, warnings }
}

// いまの形：1枚のシートに全様式。A列の目印で、様式・項目・明細の見出しを見分ける
function readCombinedSheet(ws: Sheet, forms: PackageForm[], unknown: string[]): ImportedForm[] {
  const out: ImportedForm[] = []
  let cur: ImportedForm | null = null
  let keys: string[] = []
  let inRows = false
  ws.eachRow({ includeEmpty: false }, (row) => {
    const mark = String(cellValue(row.getCell(1).value) ?? '')
    if (mark.startsWith('form:')) {
      const code = mark.slice(5)
      const form = forms.find((f) => f.code === code)
      cur = form ? { form, data: form.table ? { rows: [] } : { fields: {} }, filled: 0, warnings: [] } : null
      if (cur) out.push(cur)
      else unknown.push(`${ws.name}（${code}）`)
      keys = []
      inRows = false
      return
    }
    const c = cur as ImportedForm | null
    if (!c) return
    if (mark === 'head') { inRows = !!c.form.table; return }
    if (mark === 'keys') { keys = (row.values as unknown[]).slice(3).map((v) => String(cellValue(v) ?? '')); return }
    if (mark === '例') return
    if (mark.startsWith('f:')) {
      const f = c.form.fields?.find((x) => x.key === mark.slice(2))
      if (f && !f.compute) {
        const r = toFieldValue(f, row.getCell(4).value)
        c.data.fields![f.key] = r.value
        if (r.value !== null) c.filled++
        if (r.warn) c.warnings.push(r.warn)
      }
      return
    }
    if (mark === 'note') {
      const note = cellValue(row.getCell(4).value)
      if (note) c.data.note = String(note)
      return
    }
    if (mark === 'none') {
      c.data.none = String(cellValue(row.getCell(3).value) ?? '').trim() !== ''
      inRows = false
      return
    }
    // 明細の行（挿入した行も、目印なしで読む）
    if (inRows && c.form.table && keys.length) {
      const rec = readTableRow(c.form, keys, row, 3, c.data.rows!.length + 1, c.warnings)
      if (rec) { c.data.rows!.push(rec); c.filled = c.data.rows!.length }
    }
  })
  return out
}

export async function importPackage(file: File, forms: PackageForm[]): Promise<{ imported: ImportedForm[]; unknownSheets: string[] }> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const imported: ImportedForm[] = []
  const unknownSheets: string[] = []
  wb.eachSheet((ws) => {
    if (ws.name === 'はじめに') return
    if (cellValue(ws.getCell('A1').value) === '様式コード') {
      const code = String(cellValue(ws.getCell('B1').value) ?? '')
      const form = forms.find((f) => f.code === code)
      if (form) imported.push(readLegacySheet(ws, form))
      else unknownSheets.push(ws.name)
      return
    }
    const found = readCombinedSheet(ws, forms, unknownSheets)
    if (found.length === 0) unknownSheets.push(ws.name)
    imported.push(...found)
  })
  return { imported, unknownSheets }
}
