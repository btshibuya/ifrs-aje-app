// 収集パッケージの Excel ダウンロード・アップロード
// 1つのブックに「はじめに」と、様式ごとのシートを作る。入力する欄だけ書き込めるようにし（シートの保護）、
// 選択肢は入力規則（リスト）にする。アップロードは、シートの「様式コード」で様式を見分けて読む
// Excel の読み書きのライブラリは大きいため、ボタンを押したときにだけ読み込む

import { formatAsOf, type PackageForm, type PkgField } from './materials'
import { UNIT, formatNumber, isNumeric, parseNumber, type EntryData } from './package'

const loadExcel = async () => (await import('exceljs')).default

const HEAD_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFEEF2F8' } }
const INPUT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFFBEA' } }
const EXAMPLE_FONT = { italic: true, color: { argb: 'FF8A5A00' } }
const TABLE_ROWS = 50 // 明細の様式で、入力できる行数

const sheetName = (no: number | undefined, title: string) => `${no ?? ''}.${title}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31)

const numFmt = (f: PkgField) => (f.type === 'percent' || f.type === 'years' ? '#,##0.00' : f.type === 'days' ? '#,##0.0' : '#,##0')

export interface ExportInput {
  companyLabel: string
  asOf: string
  forms: { form: PackageForm; no?: number; data?: EntryData; prior?: (f: PkgField) => { label: string; value: unknown }[] }[]
}

export async function exportPackage(input: ExportInput): Promise<Blob> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  wb.creator = 'IFRS AJE'

  // はじめに
  const intro = wb.addWorksheet('はじめに')
  intro.columns = [{ width: 100 }]
  const lines = [
    `収集パッケージ　${input.companyLabel}　基準日 ${formatAsOf(input.asOf)}`,
    '',
    '1. 様式ごとのシートの、黄色の欄に入力してください（ほかの欄は書き換えられません）。',
    '2. 入力例と前期の値を、同じ行に並べています。金額は円、率は%の数字で入力します（例：1.2% → 1.2）。',
    '3. 明細の様式は、1行に1件です。「例」の行は入力例なので、取り込みません。行が足りなければ、アプリで追加してください。',
    '4. 入力が終わったら、アプリの収集パッケージで「Excelから取り込む」を選び、このファイルを選んでください。',
    '   取り込むと下書きとして保存されます。内容を確かめてから、アプリで「提出する」を押してください。',
    '5. シート名・シートの並び・1行目の様式コードは変えないでください（取り込むときに様式を見分けます）。',
  ]
  lines.forEach((l, i) => { intro.getCell(`A${i + 1}`).value = l })
  intro.getCell('A1').font = { bold: true, size: 14 }

  for (const { form, no, data, prior } of input.forms) {
    const ws = wb.addWorksheet(sheetName(no, form.title))
    ws.getCell('A1').value = '様式コード'
    ws.getCell('B1').value = form.code
    ws.getCell('A2').value = form.title
    ws.getCell('A2').font = { bold: true, size: 13 }
    ws.getCell('C2').value = form.intro
    ws.getCell('C2').font = { color: { argb: 'FF52514E' } }

    if (form.fields) {
      const head = ['項目キー', '項目', '単位', '今回の値（入力）', '入力例', '前期の値', '', '説明・見る場所']
      ws.getRow(4).values = head
      ws.getRow(4).font = { bold: true }
      ws.getRow(4).eachCell((c) => { c.fill = HEAD_FILL })
      ws.columns = [{ width: 4 }, { width: 30 }, { width: 6 }, { width: 18 }, { width: 18 }, { width: 26 }, { width: 26 }, { width: 70 }]
      ws.getColumn(1).hidden = true
      form.fields.forEach((f, i) => {
        const r = ws.getRow(5 + i)
        const priors = prior?.(f) ?? []
        r.values = [
          f.key, `${f.label}${f.required && !f.compute ? '（必須）' : ''}${f.compute ? '（自動計算）' : ''}`, UNIT[f.type] || '',
          (data?.fields?.[f.key] ?? null) as never,
          (isNumeric(f) ? Number(f.example) : String(f.example)) as never,
          ...priors.slice(0, 2).map((p) => `${p.label}：${p.value === undefined || p.value === null ? '—' : isNumeric(f) ? formatNumber(p.value, f.type) : String(p.value)}`),
        ]
        r.getCell(8).value = `${f.help}${f.where ? `（見る場所：${f.where}）` : ''}`
        r.getCell(8).alignment = { wrapText: true, vertical: 'top' }
        r.getCell(5).font = EXAMPLE_FONT
        const input = r.getCell(4)
        if (!f.compute) {
          input.fill = INPUT_FILL
          input.protection = { locked: false }
        }
        if (isNumeric(f)) { input.numFmt = numFmt(f); r.getCell(5).numFmt = numFmt(f) }
        if (f.type === 'select') input.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${f.options!.join(',')}"`] }
      })
      ws.getCell(`B${6 + form.fields.length}`).value = '備考（任意）'
      const note = ws.getCell(`D${6 + form.fields.length}`)
      note.value = data?.note ?? null
      note.fill = INPUT_FILL
      note.protection = { locked: false }
    }

    if (form.table) {
      const t = form.table
      ws.getRow(3).values = ['', ...t.columns.map((c) => c.key)]
      ws.getRow(3).hidden = true
      ws.getRow(4).values = ['番号', ...t.columns.map((c) => `${c.label}${c.required ? '（必須）' : ''}${UNIT[c.type] ? `［${UNIT[c.type]}］` : ''}`)]
      ws.getRow(4).font = { bold: true }
      ws.getRow(4).eachCell((c) => { c.fill = HEAD_FILL })
      ws.columns = [{ width: 6 }, ...t.columns.map((c) => ({ width: c.type === 'text' ? 26 : c.type === 'select' ? 22 : 16 }))]
      t.example.forEach((ex, i) => {
        const r = ws.getRow(5 + i)
        r.values = ['例', ...t.columns.map((c) => (ex[c.key] ?? null) as never)]
        r.font = EXAMPLE_FONT
      })
      const start = 5 + t.example.length
      const rows = data?.rows ?? []
      for (let i = 0; i < Math.max(TABLE_ROWS, rows.length); i++) {
        const r = ws.getRow(start + i)
        r.getCell(1).value = i + 1
        t.columns.forEach((c, j) => {
          const cell = r.getCell(2 + j)
          const v = rows[i]?.[c.key]
          cell.value = (v === undefined ? null : v) as never
          cell.fill = INPUT_FILL
          cell.protection = { locked: false }
          if (isNumeric(c)) cell.numFmt = numFmt(c)
          if (c.type === 'select') cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${c.options!.join(',')}"`] }
        })
      }
      const noneRow = start + Math.max(TABLE_ROWS, rows.length) + 1
      ws.getCell(`A${noneRow}`).value = '該当なし'
      ws.getCell(`B${noneRow}`).value = `「${t.emptyLabel}」場合は、右の欄に ○ を入れてください`
      const none = ws.getCell(`D${noneRow}`)
      none.value = data?.none ? '○' : null
      none.fill = INPUT_FILL
      none.protection = { locked: false }
    }
    // 入力欄以外を書き換えられないようにする（パスワードなし。様式の崩れを防ぐため）
    await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true })
  }
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

// ---------------------------------------------------------------------------
// アップロード：シートごとに様式を見分けて、入力値を読み取る
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

export async function importPackage(file: File, forms: PackageForm[]): Promise<{ imported: ImportedForm[]; unknownSheets: string[] }> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const imported: ImportedForm[] = []
  const unknownSheets: string[] = []
  wb.eachSheet((ws) => {
    if (ws.name === 'はじめに') return
    const code = String(cellValue(ws.getCell('B1').value) ?? '')
    const form = forms.find((f) => f.code === code)
    if (!form) {
      unknownSheets.push(ws.name)
      return
    }
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
        const rec: Record<string, unknown> = {}
        let any = false
        keys.forEach((k, j) => {
          const c = form.table!.columns.find((x) => x.key === k)
          if (!c) return
          const r = toFieldValue(c, row.getCell(2 + j).value)
          if (r.value !== null) any = true
          rec[k] = r.value
          if (r.warn && any) warnings.push(`${data.rows!.length + 1}行目：${r.warn}`)
        })
        if (any) data.rows!.push(rec)
      })
      filled = data.rows.length
    }
    imported.push({ form, data, filled, warnings })
  })
  return { imported, unknownSheets }
}
