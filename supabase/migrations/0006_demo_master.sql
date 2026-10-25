-- =====================================================================
-- デモ用のマスタ（ダミーデータ）
-- 子会社10社・決算期・グループ統一科目・会計方針・耐用年数・列マッピング
-- =====================================================================

insert into group_accounts (code, name, statement, bs_class, pl_class) values
  ('BS_PPE_ADJ',       '有形固定資産（IFRS調整）', 'BS', 'noncurrent_asset',     null),
  ('BS_DTA',           '繰延税金資産',             'BS', 'noncurrent_asset',     null),
  ('BS_DTL',           '繰延税金負債',             'BS', 'noncurrent_liability', null),
  ('BS_ACCRUED_LEAVE', '未払有給休暇',             'BS', 'current_liability',    null),
  ('BS_RETAINED',      '利益剰余金',               'BS', 'equity',               null),
  ('PL_SALARY',        '給料手当',                 'PL', null,                   'operating'),
  ('PL_DEPRECIATION',  '減価償却費',               'PL', null,                   'operating'),
  ('PL_DISPOSAL_LOSS', '固定資産除却損',           'PL', null,                   'operating'),
  ('PL_DEFERRED_TAX',  '法人税等調整額',           'PL', null,                   'income_tax');

insert into companies (code, name, fiscal_year_end_month, accounting_software) values
  ('S01', '東都精機株式会社',         3,  '勘定奉行'),
  ('S02', '北辰工業株式会社',         3,  '勘定奉行'),
  ('S03', '浪速物流株式会社',         3,  '弥生会計'),
  ('S04', '中部テクノサービス株式会社', 3,  '弥生会計'),
  ('S05', '九州フーズ株式会社',       3,  'freee会計'),
  ('S06', '東北エンジニアリング株式会社', 3,  'マネーフォワード'),
  ('S07', '瀬戸内マリン株式会社',     3,  'PCA会計'),
  ('S08', '関東ロジスティクス株式会社', 3,  '勘定奉行'),
  ('S09', '湘南ソフトウェア株式会社', 3,  'freee会計'),
  ('S10', 'アジア販売株式会社',       12, '勘定奉行');

-- 決算期：3月決算は 2026年3月期・2027年3月期、12月決算は 2025年12月期・2026年12月期
with prior as (
  insert into periods (company_id, label, start_date, end_date)
  select id,
         case fiscal_year_end_month when 3 then '2026年3月期' else '2025年12月期' end,
         case fiscal_year_end_month when 3 then date '2025-04-01' else date '2025-01-01' end,
         case fiscal_year_end_month when 3 then date '2026-03-31' else date '2025-12-31' end
    from companies
  returning id, company_id
)
insert into periods (company_id, label, start_date, end_date, prior_period_id)
select c.id,
       case c.fiscal_year_end_month when 3 then '2027年3月期' else '2026年12月期' end,
       case c.fiscal_year_end_month when 3 then date '2026-04-01' else date '2026-01-01' end,
       case c.fiscal_year_end_month when 3 then date '2027-03-31' else date '2026-12-31' end,
       p.id
  from companies c join prior p on p.company_id = c.id;

-- グループ共通の会計方針
insert into policies (company_id, issue_code, effective_from, applicability, params, reason) values
  (null, 'PAID_LEAVE',        '2020-01-01', 'applied',        '{"expected_usage_rate": 0.6, "social_insurance_rate": 0.15}', null),
  (null, 'LEVY',              '2020-01-01', 'applied',        '{"jgaap_property_tax_method": "accrual_by_period"}', null),
  (null, 'DEPRECIATION',      '2020-01-01', 'applied',        '{}', null),
  (null, 'LEASE',             '2020-01-01', 'applied',        '{"incremental_borrowing_rate": 0.015}', null),
  (null, 'PRESENTATION',      '2020-01-01', 'applied',        '{}', null),
  (null, 'RETIREMENT_1',      '2020-01-01', 'applied',        '{}', null),
  (null, 'RETIREMENT_2',      '2020-01-01', 'applied',        '{"discount_rate": 0.012}', null),
  (null, 'EQUITY_INSTRUMENT', '2020-01-01', 'applied',        '{"default_classification": "FVOCI"}', null),
  (null, 'GOODWILL',          '2020-01-01', 'not_applicable', '{}', '子会社にのれんなし（親会社の連結のれんは別管理）'),
  (null, 'COMPRESSION',       '2020-01-01', 'applied',        '{}', null),
  (null, 'ARO',               '2020-01-01', 'applied',        '{"discount_rate": 0.01}', null),
  (null, 'SHARE_BASED',       '2020-01-01', 'not_applicable', '{}', '子会社では株式報酬制度なし'),
  (null, 'EIR',               '2020-01-01', 'immaterial',     '{}', '借入手数料の金額が僅少'),
  (null, 'DEVELOPMENT',       '2020-01-01', 'applied',        '{}', null),
  (null, 'TAX_EFFECT',        '2020-01-01', 'applied',        '{"effective_tax_rate": 0.3062}', null);

-- 会社ごとの上書き
insert into policies (company_id, issue_code, effective_from, applicability, params, reason)
select c.id, v.issue_code, v.effective_from, v.applicability, v.params, v.reason
  from (values
    ('S03', 'TAX_EFFECT',   date '2026-04-01', 'applied',        '{"effective_tax_rate": 0.3459}'::jsonb, '外形標準課税の適用対象外となり税率が変わる'),
    ('S05', 'PAID_LEAVE',   date '2020-01-01', 'immaterial',     '{}'::jsonb, '従業員が少なく金額が僅少'),
    ('S07', 'LEVY',         date '2020-01-01', 'not_applicable', '{}'::jsonb, '固定資産税の対象資産なし（賃借のみ）'),
    ('S09', 'DEPRECIATION', date '2020-01-01', 'immaterial',     '{}'::jsonb, '有形固定資産がPC等のみで僅少'),
    ('S10', 'TAX_EFFECT',   date '2020-01-01', 'applied',        '{"effective_tax_rate": 0.25}'::jsonb, '在外子会社（現地税率）'),
    ('S02', 'PAID_LEAVE',   date '2020-01-01', 'applied',        '{"expected_usage_rate": 0.8}'::jsonb, '過去3年の消化実績による')
  ) v(company_code, issue_code, effective_from, applicability, params, reason)
  join companies c on c.code = v.company_code;

-- 資産の種類 → 経済的耐用年数（グループ共通）
insert into asset_class_rules (company_id, source_asset_type, asset_class, useful_life_years, residual_rate, method, effective_from, note) values
  (null, '建物',       '建物',         30, 0, 'straight_line', '2020-01-01', '税法38〜50年に対し使用実態で30年'),
  (null, '建物附属設備', '建物附属設備', 15, 0, 'straight_line', '2020-01-01', null),
  (null, '構築物',     '構築物',       20, 0, 'straight_line', '2020-01-01', null),
  (null, '機械装置',   '機械装置',     12, 0, 'straight_line', '2020-01-01', '税法10年に対し更新実績で12年'),
  (null, '車両運搬具', '車両運搬具',    6, 0, 'straight_line', '2020-01-01', null),
  (null, '工具器具備品', '工具器具備品',  5, 0, 'straight_line', '2020-01-01', null),
  (null, 'ソフトウェア', 'ソフトウェア',  5, 0, 'straight_line', '2020-01-01', null);

insert into asset_class_rules (company_id, source_asset_type, asset_class, useful_life_years, residual_rate, method, effective_from, note)
select id, '機械装置', '機械装置', 15, 0, 'straight_line', '2020-01-01', '重機中心のため15年'
  from companies where code = 'S02';

-- 取込ファイルの列 → アプリの項目
insert into column_mappings (company_id, source_kind, software, header_row, mapping) values
  (null, 'fixed_assets', '', 1, '{
     "asset_no": "資産番号", "name": "資産名称", "asset_type": "資産種類", "acquired_on": "取得年月日",
     "cost": "取得価額", "jgaap_life": "耐用年数", "jgaap_opening_bv": "期首帳簿価額",
     "jgaap_depreciation": "当期償却額", "jgaap_closing_bv": "期末帳簿価額", "disposed_on": "除却年月日"}'),
  (null, 'paid_leave', '', 1, '{
     "employee_no": "社員番号", "name": "氏名", "unused_days": "有給残日数", "daily_wage": "日額給与"}');

-- 弥生会計の会社は固定資産台帳の列名が違う例
insert into column_mappings (company_id, source_kind, software, header_row, mapping)
select id, 'fixed_assets', '弥生会計', 1, '{
     "asset_no": "資産コード", "name": "資産名", "asset_type": "勘定科目", "acquired_on": "取得日",
     "cost": "取得価額", "jgaap_life": "耐用年数", "jgaap_opening_bv": "期首簿価",
     "jgaap_depreciation": "償却額", "jgaap_closing_bv": "期末簿価", "disposed_on": "除却日"}'
  from companies where code = 'S04';
