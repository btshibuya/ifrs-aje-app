-- 論点の追加：金融資産の減損（予想信用損失）・固定資産の減損・引当金の取消し・その他の長期従業員給付
-- 論点11 を「借入手数料の実効金利法」から「償却原価（実効金利法）」に広げる（貸付金・借入金・社債）

update issues set name = '償却原価（実効金利法）' where code = 'EIR';

insert into issues (code, no, name, standard_ref) values
  ('ECL',         14, '金融資産の減損（予想信用損失）', 'IFRS9'),
  ('IMPAIRMENT',  15, '固定資産の減損',                 'IAS36'),
  ('PROVISION',   16, '引当金の取消し',                 'IAS37'),
  ('LT_BENEFITS', 17, 'その他の長期従業員給付',         'IAS19')
on conflict (code) do nothing;

insert into journal_categories (code, issue_code, name, carry_method, is_tax_effect, sort_order) values
  ('ECL_MAIN',  'ECL',         '予想信用損失',                   'reversing',  false, 140),
  ('ECL_TAX',   'ECL',         '予想信用損失（税効果）',         'reversing',  true,  141),
  ('IMP_MAIN',  'IMPAIRMENT',  '固定資産の減損',                 'cumulative', false, 150),
  ('IMP_TAX',   'IMPAIRMENT',  '固定資産の減損（税効果）',       'cumulative', true,  151),
  ('PROV_MAIN', 'PROVISION',   '引当金の取消し',                 'cumulative', false, 160),
  ('PROV_TAX',  'PROVISION',   '引当金の取消し（税効果）',       'cumulative', true,  161),
  ('LTB_MAIN',  'LT_BENEFITS', 'その他の長期従業員給付',         'cumulative', false, 170),
  ('LTB_TAX',   'LT_BENEFITS', 'その他の長期従業員給付（税効果）', 'cumulative', true,  171)
on conflict (code) do nothing;

update journal_categories set name = '償却原価（実効金利法）' where code = 'EIR_MAIN';
update journal_categories set name = '償却原価（税効果）' where code = 'EIR_TAX';

insert into group_accounts (code, name, statement, bs_class, pl_class) values
  ('BS_LOANS_RECEIVABLE', '貸付金',                     'BS', 'noncurrent_asset',     null),
  ('BS_BONDS',            '社債',                       'BS', 'noncurrent_liability', null),
  ('BS_ALLOWANCE',        '貸倒引当金',                 'BS', 'current_asset',        null),
  ('BS_PROVISIONS',       '引当金',                     'BS', 'current_liability',    null),
  ('BS_LT_BENEFITS',      'その他の長期従業員給付',     'BS', 'noncurrent_liability', null),
  ('PL_BAD_DEBT',         '貸倒引当金繰入額',           'PL', null,                   'operating'),
  ('PL_IMPAIRMENT',       '減損損失',                   'PL', null,                   'operating'),
  ('PL_PROVISION_EXP',    '引当金繰入額',               'PL', null,                   'operating')
on conflict (code) do nothing;

-- グループ共通の方針（予想信用損失は、延滞日数ごとの損失率で引き当てる引当マトリクス）
insert into policies (company_id, issue_code, effective_from, applicability, params, reason) values
  (null, 'ECL',         '2020-01-01', 'applied', '{"loss_rates": [0.003, 0.01, 0.05, 0.2, 0.5], "credit_impaired_rate": 1}', null),
  (null, 'IMPAIRMENT',  '2020-01-01', 'applied', '{}', null),
  (null, 'PROVISION',   '2020-01-01', 'applied', '{}', null),
  (null, 'LT_BENEFITS', '2020-01-01', 'applied', '{}', null)
on conflict do nothing;
