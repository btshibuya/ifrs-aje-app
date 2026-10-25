// 取込ファイル（Excel・CSV）を読み、列マッピングでアプリの項目に変換する

import Papa from 'papaparse'
import { readSheet } from 'read-excel-file/browser'
import type { FieldDef } from './issues'

export { sha256 } from './hash'

export type CellValue = string | number | boolean | Date | null

export async function readRows(file: File): Promise<CellValue[][]> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.xlsx')) {
    return (await readSheet(file)) as CellValue[][]
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const buf = await file.arrayBuffer()
    // 会計ソフトのCSVはShift_JISが多い。UTF-8で読めなければShift_JISで読み直す
    let text = new TextDecoder('utf-8').decode(buf)
    if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf)
    const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true })
    return parsed.data
  }
  throw new Error('Excel（.xlsx）またはCSVファイルを選んでください')
}

const pad = (n: number) => String(n).padStart(2, '0')

export function toDate(v: CellValue): string | null {
  if (v === null || v === '') return null
  // Excelの日付はUTCの0時として読まれる
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  if (typeof v === 'number') {
    // Excelのシリアル値
    const d = new Date(Math.round((v - 25569) * 86400 * 1000))
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  const m = String(v).trim().match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/)
  return m ? `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : null
}

export function toNumber(v: CellValue): number | null {
  if (v === null || v === '') return null
  if (typeof v === 'number') return v
  const s = String(v).trim().replace(/[,，円\s]/g, '').replace(/^△/, '-').replace(/^\((.*)\)$/, '-$1')
  const n = Number(s)
  return s !== '' && Number.isFinite(n) ? n : null
}

export interface MappedRow {
  rowNo: number // ファイル上の行番号（1始まり）
  itemKey: string
  data: Record<string, unknown>
  errors: string[]
}

export interface MapResult {
  rows: MappedRow[]
  missingColumns: string[]
}

export function mapRows(
  table: CellValue[][],
  headerRow: number,
  mapping: Record<string, string>,
  fields: FieldDef[],
  keyField: string,
): MapResult {
  const headers = (table[headerRow - 1] ?? []).map((h) => String(h ?? '').trim())
  const colOf: Record<string, number> = {}
  const missingColumns: string[] = []
  for (const f of fields) {
    const col = headers.indexOf(mapping[f.key] ?? '')
    if (col >= 0) colOf[f.key] = col
    else if (f.required) missingColumns.push(`${f.label}（列名「${mapping[f.key] ?? '未設定'}」）`)
  }
  if (missingColumns.length > 0) return { rows: [], missingColumns }

  const rows: MappedRow[] = []
  table.slice(headerRow).forEach((cells, i) => {
    if (cells.every((c) => c === null || String(c).trim() === '')) return
    const data: Record<string, unknown> = {}
    const errors: string[] = []
    for (const f of fields) {
      if (!(f.key in colOf)) continue
      const raw = cells[colOf[f.key]] ?? null
      let value: unknown = raw
      if (f.type === 'number') value = toNumber(raw)
      else if (f.type === 'date') value = toDate(raw)
      else value = raw === null ? null : String(raw).trim()
      if (value === null && raw !== null && String(raw).trim() !== '') errors.push(`${f.label}「${raw}」を読み取れません`)
      else if (value === null && f.required) errors.push(`${f.label}が空欄です`)
      data[f.key] = value
    }
    rows.push({ rowNo: headerRow + i + 1, itemKey: String(data[keyField] ?? ''), data, errors })
  })
  return { rows, missingColumns }
}

