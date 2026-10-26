-- 四半期への対応／連結精算表の集計の記録／デモ用の計算データの目印

-- =====================================================================
-- 1. 四半期
--    期（periods）に種類を持たせ、各年度に第1〜第3四半期を追加する
--    四半期の開始日は年度の開始日（累計期間）。前期は前年度（本決算）で、
--    計算は前年度末の確定した残高から四半期末までの累計で行う
-- =====================================================================
alter table periods add column period_type text not null default 'FY'
  check (period_type in ('Q1', 'Q2', 'Q3', 'FY'));

insert into periods (company_id, label, start_date, end_date, prior_period_id, period_type)
select p.company_id,
       p.label || ' 第' || q.n || '四半期',
       p.start_date,
       (date_trunc('month', p.start_date) + make_interval(months => 3 * q.n) - interval '1 day')::date,
       p.prior_period_id,
       'Q' || q.n
  from periods p
 cross join (values (1), (2), (3)) as q(n)
 where p.period_type = 'FY'
on conflict (company_id, end_date) do nothing;

-- =====================================================================
-- 2. 連結精算表の集計の記録
--    親会社の担当者が「集計する」を押した時点の金額を残し、
--    その後に仕訳が上書きされたとき、精算表で上書き前後を比べられるようにする
--    lines: [{company_id, issue_code, category_code, kind(opening|realization|current), account, amount(借方プラス)}]
-- =====================================================================
create table consolidation_snapshots (
  id            uuid primary key default gen_random_uuid(),
  as_of         date not null,                 -- 連結の基準日（親会社の四半期末・期末）
  label         text not null,                 -- 例: 2027年3月期 第2四半期
  lines         jsonb not null,
  note          text,
  created_by    text,                          -- ログインがないため、名前を入れる
  created_at    timestamptz not null default now(),
  is_demo_seed  boolean not null default false
);
create index consolidation_snapshots_as_of on consolidation_snapshots (as_of, created_at desc);

alter table consolidation_snapshots enable row level security;
create policy consolidation_snapshots_authenticated on consolidation_snapshots for all to authenticated using (true) with check (true);
create policy consolidation_snapshots_anon on consolidation_snapshots for all to anon using (true) with check (true);
create trigger consolidation_snapshots_log after insert or update or delete on consolidation_snapshots
  for each row execute function log_change();

-- =====================================================================
-- 3. デモ用の計算データの目印（試験データの片付けで消さない）
-- =====================================================================
alter table source_files     add column is_demo_seed boolean not null default false;
alter table detail_items     add column is_demo_seed boolean not null default false;
alter table calculation_runs add column is_demo_seed boolean not null default false;
alter table work_status      add column is_demo_seed boolean not null default false;

-- 明細の入力方法（ファイル取込／明細の手入力／合計での入力）
alter table source_files drop constraint source_files_file_type_check;
alter table source_files add constraint source_files_file_type_check
  check (file_type in ('excel', 'csv', 'pdf', 'manual'));

-- 画面用のビュー（v_progress 等）は periods をそのまま使うため、四半期も自動で並ぶ
