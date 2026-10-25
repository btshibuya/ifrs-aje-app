-- 論点の見直しと、収集パッケージ（担当者が入力する資料）の保存先

-- =====================================================================
-- 1. リース（借手）・特別損益の廃止を対象から外し、論点の番号を詰める
-- =====================================================================
delete from policies where issue_code in ('LEASE', 'PRESENTATION');
delete from journal_categories where issue_code in ('LEASE', 'PRESENTATION');
delete from issues where code in ('LEASE', 'PRESENTATION');

update issues set no = no + 100;
update issues i set no = r.rn
  from (select code, row_number() over (order by no) as rn from issues) r
 where r.code = i.code;

-- =====================================================================
-- 2. 収集パッケージ
--   会社×基準日（四半期末・期末）×様式ごとに1行。様式の定義（項目・入力例・チェック）はアプリ側
--   （src/lib/materials.ts）にある
--   data: { fields: {項目: 値}, rows: [{列: 値}], reasons: {項目: 増減の理由}, none: 該当なし, note: 備考 }
-- =====================================================================
create table package_entries (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  as_of         date not null,
  form_code     text not null,
  issue_code    text not null references issues(code),
  data          jsonb not null default '{}',
  status        text not null default 'draft' check (status in ('draft', 'submitted', 'confirmed')),
  entered_by    text,                 -- 入力者（ログイン導入後は profiles に置き換える）
  submitted_at  timestamptz,
  confirmed_at  timestamptz,
  confirmed_by  text,
  return_note   text,                 -- 差し戻しの理由
  is_demo_seed  boolean not null default false,  -- デモ用の前期値（試験データの片付けで消さない）
  updated_at    timestamptz not null default now(),
  unique (company_id, as_of, form_code),
  check ((status = 'draft') or (submitted_at is not null)),
  check ((status <> 'confirmed') or (confirmed_at is not null))
);
create index package_entries_company_idx on package_entries (company_id, as_of);

alter table package_entries enable row level security;
create policy package_entries_authenticated on package_entries for all to authenticated using (true) with check (true);
-- スタンドアロン運用（ログインなし）。ログイン導入時に削除する
create policy package_entries_anon on package_entries for all to anon using (true) with check (true);

create trigger package_entries_log after insert or update or delete on package_entries
  for each row execute function log_change();

-- 会計システムから出す資料（試算表など）は論点に結び付かないことがあるため、source_files.issue_code は任意のまま使う

-- =====================================================================
-- 3. デモ用の前期値（S01）：前年度末 2025-03-31、直前四半期 2025-12-31・2026-12-31
-- =====================================================================
insert into package_entries (company_id, as_of, form_code, issue_code, data, status, entered_by, submitted_at, confirmed_at, confirmed_by, is_demo_seed)
select c.id, v.as_of::date, v.form_code, v.issue_code, v.data::jsonb, 'confirmed', 'デモデータ', now(), now(), 'デモデータ', true
  from companies c
  cross join (values
  ('2025-03-31', 'LEAVE_USAGE', 'PAID_LEAVE', '{"fields": {"granted_days": 2280, "used_days": 1300, "employees": 112, "social_insurance_rate": 14.8}}'),
  ('2025-03-31', 'LEVY', 'LEVY', '{"fields": {"property_tax_annual": 3480000, "property_tax_unpaid": 0, "per_capita_annual": 290000}}'),
  ('2025-03-31', 'RETIREMENT_ACTUARIAL', 'RETIREMENT_1', '{"fields": {"dbo_open": 468000000, "service_cost": 31000000, "interest_cost": 4680000, "actuarial_loss": -2100000, "benefits_paid": 21500000, "dbo_close": 480080000, "plan_assets_close": 302000000}}'),
  ('2025-03-31', 'RETIREMENT_ASSUMPTIONS', 'RETIREMENT_2', '{"fields": {"discount_rate": 0.9, "discount_basis": "国債の利回り", "duration": 11.8, "attribution": "期間定額基準"}}'),
  ('2025-03-31', 'EQUITY_HOLDINGS', 'EQUITY_INSTRUMENT', '{"rows": [{"name": "東都銀行", "listed": "上場", "shares": 20000, "cost": 15000000, "fair_value": 21400000, "classification": "政策保有（売る予定なし）"}, {"name": "精密部品工業", "listed": "上場", "shares": 5000, "cost": 6000000, "fair_value": 5200000, "classification": "政策保有（売る予定なし）"}, {"name": "地域開発（非上場）", "listed": "非上場", "shares": 100, "cost": 5000000, "fair_value": 5000000, "classification": "政策保有（売る予定なし）"}]}'),
  ('2025-03-31', 'COMPRESSION_LIST', 'COMPRESSION', '{"rows": [{"asset_no": "A002", "asset_name": "空調設備", "method": "直接減額", "amount": 4000000, "subsidy": "省エネルギー投資促進補助金"}]}'),
  ('2025-03-31', 'ARO_LIST', 'ARO', '{"rows": [{"site": "本社工場の土地（借地）", "estimate": 30000000, "settle_date": "2040-03-31", "discount_rate": 1.1, "balance": 24600000}]}'),
  ('2025-03-31', 'DEV_PROJECTS', 'DEVELOPMENT', '{"rows": [{"project": "高精度センサーの開発", "spend": 22000000, "criteria": "満たさない"}]}'),
  ('2025-03-31', 'TAX', 'TAX_EFFECT', '{"fields": {"statutory_rate": 30.62, "company_class": "分類2", "deductible_td": 78000000, "tax_loss": 0, "valuation_allowance": 11000000}}'),
  ('2025-12-31', 'LEAVE_USAGE', 'PAID_LEAVE', '{"fields": {"granted_days": 1710, "used_days": 975, "employees": 112, "social_insurance_rate": 14.8}}'),
  ('2025-12-31', 'LEVY', 'LEVY', '{"fields": {"property_tax_annual": 3480000, "property_tax_unpaid": 870000, "per_capita_annual": 290000}}'),
  ('2025-12-31', 'RETIREMENT_ACTUARIAL', 'RETIREMENT_1', '{"fields": {"dbo_open": 468000000, "service_cost": 23250000, "interest_cost": 3510000, "actuarial_loss": -1575000, "benefits_paid": 16125000, "dbo_close": 477060000, "plan_assets_close": 302000000}}'),
  ('2025-12-31', 'RETIREMENT_ASSUMPTIONS', 'RETIREMENT_2', '{"fields": {"discount_rate": 0.9, "discount_basis": "国債の利回り", "duration": 11.8, "attribution": "期間定額基準"}}'),
  ('2025-12-31', 'EQUITY_HOLDINGS', 'EQUITY_INSTRUMENT', '{"rows": [{"name": "東都銀行", "listed": "上場", "shares": 20000, "cost": 15000000, "fair_value": 21400000, "classification": "政策保有（売る予定なし）"}, {"name": "精密部品工業", "listed": "上場", "shares": 5000, "cost": 6000000, "fair_value": 5200000, "classification": "政策保有（売る予定なし）"}, {"name": "地域開発（非上場）", "listed": "非上場", "shares": 100, "cost": 5000000, "fair_value": 5000000, "classification": "政策保有（売る予定なし）"}]}'),
  ('2025-12-31', 'COMPRESSION_LIST', 'COMPRESSION', '{"rows": [{"asset_no": "A002", "asset_name": "空調設備", "method": "直接減額", "amount": 4000000, "subsidy": "省エネルギー投資促進補助金"}]}'),
  ('2025-12-31', 'ARO_LIST', 'ARO', '{"rows": [{"site": "本社工場の土地（借地）", "estimate": 30000000, "settle_date": "2040-03-31", "discount_rate": 1.1, "balance": 24600000}]}'),
  ('2025-12-31', 'DEV_PROJECTS', 'DEVELOPMENT', '{"rows": [{"project": "高精度センサーの開発", "spend": 16500000, "criteria": "満たさない"}]}'),
  ('2025-12-31', 'TAX', 'TAX_EFFECT', '{"fields": {"statutory_rate": 30.62, "company_class": "分類2", "deductible_td": 78000000, "tax_loss": 0, "valuation_allowance": 11000000}}'),
  ('2026-12-31', 'LEAVE_USAGE', 'PAID_LEAVE', '{"fields": {"granted_days": 1778, "used_days": 1014, "employees": 118, "social_insurance_rate": 15.2}}'),
  ('2026-12-31', 'LEVY', 'LEVY', '{"fields": {"property_tax_annual": 3620000, "property_tax_unpaid": 905000, "per_capita_annual": 290000}}'),
  ('2026-12-31', 'RETIREMENT_ACTUARIAL', 'RETIREMENT_1', '{"fields": {"dbo_open": 485560000, "service_cost": 24180000, "interest_cost": 3650400, "actuarial_loss": -1638000, "benefits_paid": 16770000, "dbo_close": 494982400, "plan_assets_close": 318000000}}'),
  ('2026-12-31', 'RETIREMENT_ASSUMPTIONS', 'RETIREMENT_2', '{"fields": {"discount_rate": 1.3, "discount_basis": "国債の利回り", "duration": 11.8, "attribution": "期間定額基準"}}'),
  ('2026-12-31', 'EQUITY_HOLDINGS', 'EQUITY_INSTRUMENT', '{"rows": [{"name": "東都銀行", "listed": "上場", "shares": 20000, "cost": 15000000, "fair_value": 24800000, "classification": "政策保有（売る予定なし）"}, {"name": "精密部品工業", "listed": "上場", "shares": 5000, "cost": 6000000, "fair_value": 6900000, "classification": "政策保有（売る予定なし）"}, {"name": "地域開発（非上場）", "listed": "非上場", "shares": 100, "cost": 5000000, "fair_value": 5000000, "classification": "政策保有（売る予定なし）"}]}'),
  ('2026-12-31', 'COMPRESSION_LIST', 'COMPRESSION', '{"rows": [{"asset_no": "A002", "asset_name": "空調設備", "method": "直接減額", "amount": 4000000, "subsidy": "省エネルギー投資促進補助金"}]}'),
  ('2026-12-31', 'ARO_LIST', 'ARO', '{"rows": [{"site": "本社工場の土地（借地）", "estimate": 30000000, "settle_date": "2040-03-31", "discount_rate": 1.1, "balance": 25200000}]}'),
  ('2026-12-31', 'DEV_PROJECTS', 'DEVELOPMENT', '{"rows": [{"project": "高精度センサーの開発", "spend": 17160000, "criteria": "満たさない"}]}'),
  ('2026-12-31', 'TAX', 'TAX_EFFECT', '{"fields": {"statutory_rate": 30.62, "company_class": "分類2", "deductible_td": 83500000, "tax_loss": 0, "valuation_allowance": 11000000}}')
  ) as v(as_of, form_code, issue_code, data)
 where c.code = 'S01';
