import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMS, formByCode } from './materials'
import { exportPackage, importPackage } from './packageExcel'

const toFile = async (blob: Blob) => new File([await blob.arrayBuffer()], 'package.xlsx')

describe('収集パッケージのExcel（1枚のシートに全様式）', () => {
  it('書き出した値を、そのまま読み戻せる（項目の様式・明細の様式・該当なし）', async () => {
    const blob = await exportPackage({
      companyLabel: 'S01 テスト', asOf: '2027-03-31',
      forms: [
        { form: formByCode('LEVY')!, no: 2, data: { fields: { property_tax_annual: 3_600_000, property_tax_unpaid: 900_000, per_capita_annual: 290_000 }, note: 'メモ' } },
        { form: formByCode('EQUITY_HOLDINGS')!, no: 6, data: { rows: [
          { name: 'A銀行', listed: '上場', shares: 1000, cost: 100, fair_value: 150, classification: '売買目的' },
          { name: 'B社', listed: '非上場', shares: 10, cost: 50, fair_value: 70, classification: '政策保有（売る予定なし）' },
        ] } },
        { form: formByCode('PROVISIONS_LIST')!, no: 16, data: { none: true } },
      ],
    })
    const { imported, unknownSheets } = await importPackage(await toFile(blob), PACKAGE_FORMS)
    expect(unknownSheets).toEqual([])
    const by = (code: string) => imported.find((x) => x.form.code === code)!
    expect(by('LEVY').data.fields).toMatchObject({ property_tax_annual: 3_600_000, property_tax_unpaid: 900_000, per_capita_annual: 290_000 })
    expect(by('LEVY').data.note).toBe('メモ')
    expect(by('EQUITY_HOLDINGS').data.rows).toHaveLength(2)
    expect(by('EQUITY_HOLDINGS').data.rows![1]).toMatchObject({ name: 'B社', listed: '非上場', cost: 50, fair_value: 70 })
    expect(by('PROVISIONS_LIST').data.none).toBe(true)
    expect(imported.every((x) => x.warnings.length === 0)).toBe(true)
  })

  it('シートは「はじめに」と「入力」の2枚。目次から各様式へ移れ、書体はアプリと同じ', async () => {
    const blob = await exportPackage({ companyLabel: 'S01', asOf: '2027-03-31', forms: PACKAGE_FORMS.map((form, i) => ({ form, no: i + 1 })) })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    expect(wb.worksheets.map((w) => w.name)).toEqual(['はじめに', '入力'])
    const ws = wb.getWorksheet('入力')!
    const link = ws.getCell('B4').value as { hyperlink: string }
    expect(link.hyperlink).toMatch(/^#'入力'!B\d+$/)
    const target = Number(link.hyperlink.split('!B')[1])
    expect(ws.getCell(target, 1).value).toBe(`form:${PACKAGE_FORMS[0].code}`)
    expect(ws.getCell('B1').font.name).toBe('Meiryo')
  })

  it('明細の行を挿入して入力しても読み取れる', async () => {
    const blob = await exportPackage({ companyLabel: 'S01', asOf: '2027-03-31', forms: [{ form: formByCode('PROVISIONS_LIST')!, data: { rows: [{ name: '修繕引当金', ifrs: '計上できない', balance: 1 }] } }] })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const ws = wb.getWorksheet('入力')!
    let at = 0
    // 入力の1行目（「例」の行ではなく、番号1の行）の下に挿入する
    ws.eachRow((row, n) => { if (!at && row.getCell(2).value === 1 && row.getCell(3).value === '修繕引当金') at = n })
    ws.insertRow(at + 1, [null, null, '特別修繕引当金', '', '計上できない', 2])
    const buf = await wb.xlsx.writeBuffer()
    const { imported } = await importPackage(new File([buf], 'x.xlsx'), PACKAGE_FORMS)
    expect(imported[0].data.rows!.map((r) => r.name)).toEqual(['修繕引当金', '特別修繕引当金'])
  })
})
