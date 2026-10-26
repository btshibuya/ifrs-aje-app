// 連結精算表を Excel で出力する（区分ごとの小計・合計・貸借の検証・当期利益への影響の行つき）
// Excel の読み書きのライブラリは大きいため、ボタンを押したときにだけ読み込む

export interface SheetRow { kind: 'section' | 'account' | 'subtotal' | 'check' | 'profit'; label: string; code?: string; values: number[]; before?: number | null }

export async function exportWorksheet(input: { title: string; subtitle: string; columns: string[]; rows: SheetRow[]; compare: boolean }): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'IFRS AJE'
  const ws = wb.addWorksheet('連結精算表', { views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }] })
  const fmt = '#,##0;[Red]△#,##0;"-"'
  ws.getCell('A1').value = input.title
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = input.subtitle
  ws.getCell('A2').font = { color: { argb: 'FF52514E' } }
  const head = ['科目', 'コード', ...input.columns, '合計', ...(input.compare ? ['前回の集計（合計）', '差額'] : [])]
  ws.getRow(4).values = head
  ws.getRow(4).font = { bold: true }
  ws.getRow(4).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F8' } }; c.alignment = { horizontal: 'center', wrapText: true } })
  ws.columns = [{ width: 30 }, { width: 18 }, ...input.columns.map(() => ({ width: 16 })), { width: 18 }, ...(input.compare ? [{ width: 18 }, { width: 16 }] : [])]
  let r = 5
  for (const row of input.rows) {
    const x = ws.getRow(r++)
    if (row.kind === 'section') {
      x.getCell(1).value = row.label
      x.font = { bold: true, color: { argb: 'FF6B7785' } }
      continue
    }
    const total = row.values.reduce((s, v) => s + v, 0)
    x.values = [row.label, row.code ?? '', ...row.values.map((v) => Math.round(v)), Math.round(total),
      ...(input.compare && row.before !== undefined && row.before !== null ? [Math.round(row.before), Math.round(total - row.before)] : [])]
    for (let c = 3; c <= head.length; c++) x.getCell(c).numFmt = fmt
    if (row.kind !== 'account') {
      x.font = { bold: true }
      x.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row.kind === 'profit' ? 'FFE8F0FB' : 'FFF3F5F8' } } })
    }
  }
  ws.getCell(`A${r + 1}`).value = '借方はそのまま、貸方は△（円）。当期利益への影響はプラス＝利益が増える。'
  ws.getCell(`A${r + 1}`).font = { color: { argb: 'FF6B7785' } }
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
