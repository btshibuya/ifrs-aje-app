-- =====================================================================
-- 日本基準→IFRS AJE起票アプリ  プロトタイプ用スキーマ v0.1
-- 対象: Supabase (PostgreSQL)
-- 金額は円単位（numeric(20,2)）、借方・貸方は side で持つ
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
-- 1. ユーザー
-- =====================================================================

-- Supabase Auth のユーザー（auth.users）に表示名を付ける
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  role          text not null default 'member' check (role in ('admin', 'member')),
  created_at    timestamptz not null default now()
);

-- =====================================================================
-- 2. マスタ
-- =====================================================================

create table companies (
  id                     uuid primary key default gen_random_uuid(),
  code                   text not null unique,
  name                   text not null,
  fiscal_year_end_month  int  not null check (fiscal_year_end_month between 1 and 12),
  accounting_software    text,                       -- 勘定奉行、弥生 など
  is_active              boolean not null default true,
  created_at             timestamptz not null default now()
);

-- 会社ごとの決算期。prior_period_id で前期とつなぐ
create table periods (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  label            text not null,                    -- 例: 2027年3月期
  start_date       date not null,
  end_date         date not null,
  prior_period_id  uuid references periods(id),
  scope_event      text check (scope_event in ('new_consolidation', 'deconsolidation', 'merger', 'fy_change')),
  created_at       timestamptz not null default now(),
  unique (company_id, end_date),
  check (start_date < end_date)
);

-- 論点マスタ（15論点）
create table issues (
  code          text primary key,
  no            int  not null unique,
  name          text not null,
  standard_ref  text
);

-- 仕訳区分マスタ。BTrexの開始仕訳の方式と1対1で対応させる
--   cumulative = 累積（アプリは当期の変動分を出力）
--   reversing  = 洗替（アプリは当期末の全額を出力）
--   reclass    = 組換（アプリは当期の全額を出力、翌期への引継ぎなし）
create table journal_categories (
  code                 text primary key,
  issue_code           text not null references issues(code),
  name                 text not null,
  carry_method         text not null check (carry_method in ('cumulative', 'reversing', 'reclass')),
  is_tax_effect        boolean not null default false,
  btrex_category_code  text,
  sort_order           int not null default 0
);

-- グループ統一科目
create table group_accounts (
  code                text primary key,
  name                text not null,
  statement           text not null check (statement in ('BS', 'PL', 'OCI')),
  bs_class            text check (bs_class in ('current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability', 'equity')),
  pl_class            text check (pl_class in ('operating', 'finance', 'income_tax')),
  btrex_account_code  text,
  check ((statement = 'BS') = (bs_class is not null))
);

-- 科目マッピング（子会社の科目 → グループ統一科目）
create table account_mappings (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  source_code         text not null,
  source_name         text,
  group_account_code  text not null references group_accounts(code),
  unique (company_id, source_code)
);

-- 列マッピング（取込ファイルの列 → アプリの項目）。company_id が null ならグループ共通
--   mapping 例: {"asset_no": "資産コード", "acquired_on": "取得年月日", "cost": "取得価額"}
create table column_mappings (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references companies(id),
  source_kind  text not null,                        -- fixed_assets, paid_leave, lease_contracts など
  software     text not null default '',
  header_row   int  not null default 1,
  mapping      jsonb not null,
  updated_by   uuid references profiles(id),
  updated_at   timestamptz not null default now(),
  unique nulls not distinct (company_id, source_kind, software)
);

-- 区分マッピング（資産の種類 → 経済的耐用年数など）。company_id が null ならグループ共通
create table asset_class_rules (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid references companies(id),
  source_asset_type  text not null,                  -- 台帳上の種類（建物、器具備品 など）
  asset_class        text not null,                  -- グループの資産区分
  useful_life_years  numeric(5,2) not null check (useful_life_years > 0),
  residual_rate      numeric(5,4) not null default 0 check (residual_rate between 0 and 1),
  method             text not null default 'straight_line' check (method in ('straight_line', 'declining_balance')),
  effective_from     date not null,
  note               text,
  unique nulls not distinct (company_id, source_asset_type, effective_from)
);

-- 会計方針・前提値。company_id が null ならグループ共通、値があれば会社ごとの上書き
--   params 例（賦課金）: {"jgaap_property_tax_method": "accrual_by_period"}
--   params 例（税効果）: {"effective_tax_rate": 0.3062}
create table policies (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references companies(id),
  issue_code      text not null references issues(code),
  effective_from  date not null,
  applicability   text not null check (applicability in ('applied', 'not_applicable', 'immaterial')),
  params          jsonb not null default '{}',
  reason          text,                              -- 対象外・重要性なしの理由
  updated_by      uuid references profiles(id),
  updated_at      timestamptz not null default now(),
  unique nulls not distinct (company_id, issue_code, effective_from)
);

-- =====================================================================
-- 3. 取込データとチェック
-- =====================================================================

-- 元資料。原本は Supabase Storage の source-files バケットに置く
create table source_files (
  id            uuid primary key default gen_random_uuid(),
  period_id     uuid not null references periods(id),
  issue_code    text references issues(code),
  source_kind   text not null,
  file_name     text not null,
  file_type     text not null check (file_type in ('excel', 'csv', 'pdf')),
  storage_path  text not null unique,
  sha256        text not null,
  uploaded_by   uuid references profiles(id),
  uploaded_at   timestamptz not null default now()
);

-- 取り込んだ明細（固定資産1件、従業員1名、リース契約1件 など）
-- 論点ごとに項目が違うため data は jsonb で持つ
create table detail_items (
  id              uuid primary key default gen_random_uuid(),
  period_id       uuid not null references periods(id),
  issue_code      text not null references issues(code),
  item_key        text not null,                     -- 資産番号、社員番号、契約番号など
  source_file_id  uuid references source_files(id),
  source_row_no   int,
  source_page_no  int,                               -- PDFのページ
  data            jsonb not null,
  review_status   text not null default 'pending' check (review_status in ('pending', 'checked')),
  checked_by      uuid references profiles(id),
  checked_at      timestamptz,
  unique (period_id, issue_code, item_key),
  check ((review_status = 'checked') = (checked_by is not null and checked_at is not null))
);

-- PDF読取結果の項目ごとの確認・手修正の記録
create table field_reviews (
  id               uuid primary key default gen_random_uuid(),
  detail_item_id   uuid not null references detail_items(id) on delete cascade,
  field_name       text not null,
  extracted_value  text,
  confidence       numeric(4,3) check (confidence between 0 and 1),
  corrected_value  text,                             -- 手修正した場合のみ
  reviewed_by      uuid references profiles(id),
  reviewed_at      timestamptz not null default now()
);

-- 明細番号の新旧対応（会計ソフト変更・台帳統合で番号が変わった場合）
create table item_key_links (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  issue_code  text not null references issues(code),
  old_key     text not null,
  new_key     text not null,
  period_id   uuid not null references periods(id),  -- 変更が起きた期
  note        text,
  unique (company_id, issue_code, old_key)
);

-- =====================================================================
-- 4. 計算と仕訳
-- =====================================================================

-- 計算の実行。前提値はスナップショットとして保存し、あとから再現できるようにする
create table calculation_runs (
  id                    uuid primary key default gen_random_uuid(),
  period_id             uuid not null references periods(id),
  issue_code            text not null references issues(code),
  status                text not null default 'draft' check (status in ('draft', 'final', 'superseded')),
  assumptions_snapshot  jsonb not null,
  input_hash            text not null,               -- 入力明細のハッシュ（入力が変わったら再計算を促す）
  run_by                uuid references profiles(id),
  run_at                timestamptz not null default now(),
  note                  text
);

-- 1つの論点・期で有効な計算は1つだけ
create unique index calculation_runs_one_active
  on calculation_runs (period_id, issue_code)
  where status in ('draft', 'final');

-- 計算シートの1行（ブラックボックスにしないための計算過程）
create table calculation_steps (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references calculation_runs(id) on delete cascade,
  item_key        text,                              -- null は論点全体の集計行
  step_no         int  not null,
  label           text not null,                     -- 例: IFRS償却額
  formula         text,                              -- 例: (取得価額 - 残存価額) ÷ 経済的耐用年数 × 12/12
  value           numeric(20,2),
  detail_item_id  uuid references detail_items(id),
  unique (run_id, item_key, step_no)
);

-- 明細ごとの期末残高（翌期のロールフォワードの起点）
-- 1つの明細に複数の残高がある場合は balance_type で分ける（リースの使用権資産とリース負債など）
create table item_balances (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references calculation_runs(id) on delete cascade,
  period_id             uuid not null references periods(id),
  issue_code            text not null references issues(code),
  item_key              text not null,
  balance_type          text not null default 'main',
  jgaap_amount          numeric(20,2) not null default 0,
  ifrs_amount           numeric(20,2) not null default 0,
  difference            numeric(20,2) generated always as (ifrs_amount - jgaap_amount) stored,
  oci_accumulated       numeric(20,2) not null default 0,   -- 退職給付の再測定、FVOCIの評価差額
  temporary_difference  numeric(20,2),
  movement_type         text not null check (movement_type in ('new', 'continuing', 'disposed')),
  extra                 jsonb not null default '{}',
  unique (run_id, item_key, balance_type)
);

create table journal_entries (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references calculation_runs(id) on delete cascade,
  period_id      uuid not null references periods(id),
  issue_code     text not null references issues(code),
  category_code  text not null references journal_categories(code),
  entry_no       int  not null,
  description    text not null,
  unique (run_id, entry_no)
);

create table journal_lines (
  id                   uuid primary key default gen_random_uuid(),
  entry_id             uuid not null references journal_entries(id) on delete cascade,
  line_no              int  not null,
  side                 text not null check (side in ('debit', 'credit')),
  group_account_code   text not null references group_accounts(code),
  amount               numeric(20,2) not null check (amount >= 0),
  memo                 text,
  calculation_step_id  uuid references calculation_steps(id),   -- この金額の計算根拠
  unique (entry_id, line_no)
);

-- =====================================================================
-- 5. BTrexとの突合
-- =====================================================================

-- BTrexの開始仕訳の結果を取り込み、アプリが持つ前期末残高と照合する
-- amount は借方をプラス、貸方をマイナスで持つ
create table btrex_opening_balances (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid not null references periods(id),
  category_code       text not null references journal_categories(code),
  group_account_code  text not null references group_accounts(code),
  amount              numeric(20,2) not null,
  source_file_id      uuid references source_files(id),
  imported_by         uuid references profiles(id),
  imported_at         timestamptz not null default now(),
  unique (period_id, category_code, group_account_code)
);

-- =====================================================================
-- 6. 進捗・確定ロック・変更履歴
-- =====================================================================

-- 会社×期×論点の進捗。locked にすると関連データを変更できなくなる
create table work_status (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references periods(id),
  issue_code  text not null references issues(code),
  status      text not null default 'not_started'
              check (status in ('not_started', 'imported', 'checked', 'calculated', 'locked')),
  locked_by   uuid references profiles(id),
  locked_at   timestamptz,
  updated_by  uuid references profiles(id),
  updated_at  timestamptz not null default now(),
  unique (period_id, issue_code),
  check ((status = 'locked') = (locked_by is not null and locked_at is not null))
);

create table change_logs (
  id           bigint generated always as identity primary key,
  table_name   text not null,
  record_id    text,
  action       text not null,
  before_data  jsonb,
  after_data   jsonb,
  changed_by   uuid,
  changed_at   timestamptz not null default now()
);

-- 確定済み（locked）の会社×期×論点のデータ変更を拒否する
create function assert_not_locked() returns trigger
language plpgsql set search_path = public as $$
declare
  r          record := coalesce(new, old);
  v_period   uuid;
  v_issue    text;
begin
  if TG_TABLE_NAME = 'journal_lines' then
    select e.period_id, e.issue_code into v_period, v_issue
      from journal_entries e where e.id = r.entry_id;
  elsif TG_TABLE_NAME in ('calculation_steps') then
    select c.period_id, c.issue_code into v_period, v_issue
      from calculation_runs c where c.id = r.run_id;
  elsif TG_TABLE_NAME = 'field_reviews' then
    select d.period_id, d.issue_code into v_period, v_issue
      from detail_items d where d.id = r.detail_item_id;
  else
    v_period := r.period_id;
    v_issue  := r.issue_code;
  end if;

  if exists (select 1 from work_status w
              where w.period_id = v_period and w.issue_code = v_issue and w.status = 'locked') then
    raise exception '確定済みのため変更できません（確定を解除してください）';
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['detail_items', 'field_reviews', 'calculation_runs', 'calculation_steps',
                           'item_balances', 'journal_entries', 'journal_lines'] loop
    execute format('create trigger %I before insert or update or delete on %I
                    for each row execute function assert_not_locked()', t || '_lock', t);
  end loop;
end $$;

-- 変更履歴を自動で記録する
create function log_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into change_logs (table_name, record_id, action, before_data, after_data, changed_by)
  values (TG_TABLE_NAME,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
          TG_OP,
          case when TG_OP <> 'INSERT' then to_jsonb(old) end,
          case when TG_OP <> 'DELETE' then to_jsonb(new) end,
          auth.uid());
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['companies', 'periods', 'journal_categories', 'group_accounts',
                           'account_mappings', 'column_mappings', 'asset_class_rules', 'policies',
                           'source_files', 'detail_items', 'field_reviews', 'item_key_links',
                           'calculation_runs', 'item_balances', 'journal_entries', 'journal_lines',
                           'btrex_opening_balances', 'work_status'] loop
    execute format('create trigger %I after insert or update or delete on %I
                    for each row execute function log_change()', t || '_log', t);
  end loop;
end $$;

-- =====================================================================
-- 7. 画面用のビュー
-- =====================================================================

-- 会社別方針一覧：会社×期×論点ごとの有効な方針（会社の上書き ＞ グループ共通）
create view v_policy_matrix with (security_invoker = true) as
select c.code  as company_code,
       c.name  as company_name,
       p.id    as period_id,
       p.label as period_label,
       i.no    as issue_no,
       i.code  as issue_code,
       i.name  as issue_name,
       coalesce(cp.applicability, gp.applicability) as applicability,
       coalesce(gp.params, '{}') || coalesce(cp.params, '{}') as params,
       coalesce(cp.reason, gp.reason) as reason,
       cp.id is not null as is_company_override
  from companies c
  join periods p on p.company_id = c.id
  cross join issues i
  left join lateral (
        select * from policies x
         where x.company_id = c.id and x.issue_code = i.code and x.effective_from <= p.end_date
         order by x.effective_from desc limit 1) cp on true
  left join lateral (
        select * from policies x
         where x.company_id is null and x.issue_code = i.code and x.effective_from <= p.end_date
         order by x.effective_from desc limit 1) gp on true;

-- 論点別影響額一覧：有効な計算の仕訳を、会社×期×論点×BS/PL/OCIで集計（借方プラス）
create view v_impact_summary with (security_invoker = true) as
select c.code  as company_code,
       p.id    as period_id,
       p.label as period_label,
       e.issue_code,
       a.statement,
       sum(case l.side when 'debit' then l.amount else -l.amount end) as net_debit
  from journal_entries e
  join calculation_runs r on r.id = e.run_id and r.status in ('draft', 'final')
  join journal_lines l    on l.entry_id = e.id
  join group_accounts a   on a.code = l.group_account_code
  join periods p          on p.id = e.period_id
  join companies c        on c.id = p.company_id
 group by c.code, p.id, p.label, e.issue_code, a.statement;

-- 進捗一覧：会社×期×論点の状況（未登録は not_started）
create view v_progress with (security_invoker = true) as
select c.code  as company_code,
       p.id    as period_id,
       p.label as period_label,
       i.no    as issue_no,
       i.code  as issue_code,
       coalesce(w.status, 'not_started') as status,
       w.locked_at,
       w.updated_at
  from companies c
  join periods p on p.company_id = c.id
  cross join issues i
  left join work_status w on w.period_id = p.id and w.issue_code = i.code;

-- 貸借が一致しない仕訳（出力前のチェック用）
create view v_unbalanced_entries with (security_invoker = true) as
select e.id as entry_id, e.period_id, e.issue_code, e.entry_no,
       sum(case l.side when 'debit' then l.amount else 0 end) as debit_total,
       sum(case l.side when 'credit' then l.amount else 0 end) as credit_total
  from journal_entries e
  join journal_lines l on l.entry_id = e.id
 group by e.id
having sum(case l.side when 'debit' then l.amount else -l.amount end) <> 0;

-- 期首チェック：前期末の明細残高と、当期に引き継いだ明細の突合
-- 前期末にあって当期の計算に出てこない明細（除却等の処理漏れ）を検出する
create view v_missing_carryforward with (security_invoker = true) as
select cur.id as period_id, prev_b.issue_code, prev_b.item_key, prev_b.balance_type,
       prev_b.difference as prior_closing_difference
  from periods cur
  join calculation_runs prev_r on prev_r.period_id = cur.prior_period_id and prev_r.status = 'final'
  join item_balances prev_b    on prev_b.run_id = prev_r.id and prev_b.movement_type <> 'disposed'
  join periods prev_p          on prev_p.id = cur.prior_period_id
 where not exists (
        select 1
          from calculation_runs r
          join item_balances b on b.run_id = r.id
         where r.period_id = cur.id
           and r.status in ('draft', 'final')
           and b.issue_code = prev_b.issue_code
           and b.balance_type = prev_b.balance_type
           and b.item_key = coalesce(
                 (select k.new_key from item_key_links k
                   where k.company_id = prev_p.company_id and k.issue_code = prev_b.issue_code
                     and k.old_key = prev_b.item_key),
                 prev_b.item_key));

-- =====================================================================
-- 8. アクセス制御（ログインした担当者は全データを読み書きできる）
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array['profiles', 'companies', 'periods', 'issues', 'journal_categories',
                           'group_accounts', 'account_mappings', 'column_mappings', 'asset_class_rules',
                           'policies', 'source_files', 'detail_items', 'field_reviews', 'item_key_links',
                           'calculation_runs', 'calculation_steps', 'item_balances', 'journal_entries',
                           'journal_lines', 'btrex_opening_balances', 'work_status'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to authenticated using (true) with check (true)',
                   t || '_authenticated', t);
  end loop;
end $$;

-- 変更履歴は読み取りのみ（書込みはトリガーだけ）
alter table change_logs enable row level security;
create policy change_logs_read on change_logs for select to authenticated using (true);
