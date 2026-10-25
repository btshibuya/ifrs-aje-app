-- マスタをアプリから追加・非表示・削除できるようにする／収集パッケージの仕訳プレビューで使う統一科目

-- =====================================================================
-- 1. 非表示（使わなくなったマスタを、削除せずに一覧・選択肢から外す）
--    会社は既存の is_active を使う
-- =====================================================================
alter table issues             add column is_hidden boolean not null default false;
alter table group_accounts     add column is_hidden boolean not null default false;
alter table journal_categories add column is_hidden boolean not null default false;
alter table asset_class_rules  add column is_hidden boolean not null default false;
alter table column_mappings    add column is_hidden boolean not null default false;

-- 論点の変更も変更履歴に残す（ほかのマスタは 0001 で記録済み）
create trigger issues_log after insert or update or delete on issues
  for each row execute function log_change();

-- =====================================================================
-- 2. 収集パッケージの仕訳プレビューで使う統一科目
-- =====================================================================
insert into group_accounts (code, name, statement, bs_class, pl_class) values
  ('BS_INVESTMENTS',      '投資有価証券',               'BS',  'noncurrent_asset',     null),
  ('BS_GOODWILL',         'のれん',                     'BS',  'noncurrent_asset',     null),
  ('BS_INTANGIBLE',       '無形資産（開発資産）',       'BS',  'noncurrent_asset',     null),
  ('BS_ACCRUED_LEVY',     '未払賦課金',                 'BS',  'current_liability',    null),
  ('BS_DEFERRED_INCOME',  '繰延収益（政府補助金）',     'BS',  'noncurrent_liability', null),
  ('BS_ARO',              '資産除去債務',               'BS',  'noncurrent_liability', null),
  ('BS_BORROWINGS',       '借入金',                     'BS',  'noncurrent_liability', null),
  ('BS_RETIREMENT_LIAB',  '退職給付に係る負債',         'BS',  'noncurrent_liability', null),
  ('BS_OCI_RESERVE',      'その他の資本の構成要素',     'BS',  'equity',               null),
  ('PL_TAXES',            '租税公課',                   'PL',  null,                   'operating'),
  ('PL_RETIREMENT',       '退職給付費用',               'PL',  null,                   'operating'),
  ('PL_RND',              '研究開発費',                 'PL',  null,                   'operating'),
  ('PL_GOODWILL_AMORT',   'のれん償却額',               'PL',  null,                   'operating'),
  ('PL_FINANCE_INCOME',   '金融収益',                   'PL',  null,                   'finance'),
  ('PL_FINANCE_COST',     '金融費用',                   'PL',  null,                   'finance'),
  ('OCI_REMEASUREMENT',   '確定給付制度の再測定',       'OCI', null,                   null),
  ('OCI_FVOCI',           'FVOCI資本性金融商品の公正価値の変動', 'OCI', null,          null)
on conflict (code) do nothing;
