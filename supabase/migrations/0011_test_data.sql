-- テストデータ（全13論点）を入れる・全て消すボタンのための準備

-- 会社ごとの方針の上書きもテストデータとして入れる（のれん・株式報酬・借入手数料を一部の会社で「適用」にする）
-- 目印を付け、全て消すときに元の方針に戻す
alter table policies add column is_demo_seed boolean not null default false;

-- 株式報酬の調整仕訳に使う統一科目
insert into group_accounts (code, name, statement, bs_class, pl_class) values
  ('BS_SHARE_OPTIONS', '新株予約権（株式報酬）', 'BS', 'equity', null),
  ('PL_SHARE_COMP',    '株式報酬費用',           'PL', null,     'operating')
on conflict (code) do nothing;

-- テストデータ画面の件数を1回の問い合わせで数える（テストデータ／画面で入力したもの）
create or replace function test_data_counts() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'package_entries',         (select jsonb_build_object('test', count(*) filter (where is_demo_seed), 'other', count(*) filter (where not is_demo_seed)) from package_entries),
    'source_files',            (select jsonb_build_object('test', count(*) filter (where is_demo_seed), 'other', count(*) filter (where not is_demo_seed)) from source_files),
    'detail_items',            (select jsonb_build_object('test', count(*) filter (where is_demo_seed), 'other', count(*) filter (where not is_demo_seed)) from detail_items),
    'calculation_runs',        (select jsonb_build_object('test', count(*) filter (where is_demo_seed), 'other', count(*) filter (where not is_demo_seed)) from calculation_runs where status <> 'superseded'),
    'work_status',             (select jsonb_build_object('test', count(*) filter (where is_demo_seed), 'other', count(*) filter (where not is_demo_seed)) from work_status),
    'consolidation_snapshots', (select jsonb_build_object('test', count(*) filter (where is_demo_seed), 'other', count(*) filter (where not is_demo_seed)) from consolidation_snapshots),
    'policies',                (select jsonb_build_object('test', count(*) filter (where is_demo_seed), 'other', 0) from policies)
  )
$$;
grant execute on function test_data_counts() to anon, authenticated;
